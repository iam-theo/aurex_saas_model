import { spawn } from "node:child_process";

/**
 * Runs the agent inside a workspace container via `docker exec`,
 * streaming NDJSON events on stdout. Returns exit code.
 */
export function runAgentInContainer(opts: {
  containerName: string;
  model: string;
  task: string;
  env?: Record<string, string>;
  timeoutMs: number;
  onLine: (line: string) => void;
  signal: AbortSignal;
}): Promise<number> {
  const { containerName, model, task, env, timeoutMs, onLine, signal } = opts;

  return new Promise((resolve, reject) => {
    const dockerArgs = ["exec", "-i", "--env", `MODEL=${model}`, "--env", `TASK=${task}`];
    for (const [k, v] of Object.entries(env ?? {})) {
      dockerArgs.push("--env", `${k}=${v}`);
    }
    // Run inside the project folder when a WORKDIR is provided (defaults to
    // the workspace root). `sh -c` runs as the container's agent user.
    dockerArgs.push(
      containerName,
      "sh",
      "-c",
      'cd "${WORKDIR:-/workspace}" 2>/dev/null || cd /workspace; exec /usr/local/bin/aurex-agent',
    );

    const child = spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });

    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`agent run timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("agent run aborted"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
      }
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      if (buffer.trim()) onLine(buffer.trim());
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (stderrBuf && !code) {
        // surface stderr only on failure paths
        console.error(`[aurex-worker] agent stderr: ${stderrBuf}`);
      }
      resolve(code ?? 0);
    });

    child.stdin.end();
  });
}
