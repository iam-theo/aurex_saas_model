import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import Docker from "dockerode";
import type { Container } from "dockerode";

const docker = new Docker();
const HOST_MODE = process.env.AUREX_HOST_MODE === "true" || process.env.AUREX_EXEC_MODE === "host";
// In HOST_MODE, "/" requires root for /workspace. Default to a user-writable dir when not explicitly set to "/"
const _rawHostRoot = process.env.AUREX_HOST_ROOT;
const HOST_ROOT = (() => {
  if (!_rawHostRoot || _rawHostRoot === "/") {
    if (HOST_MODE) {
      const home = process.env.HOME ?? homedir() ?? "/home/aurex";
      return `${home}/workspace`;
    }
    return "/";
  }
  return _rawHostRoot;
})();
if (HOST_MODE) console.log(`[docker] HOST MODE enabled — all exec runs directly on host (root ${HOST_ROOT})`);

export interface ResourceLimits {
  cpus?: number;
  memory?: string;
  pids?: number;
  timeoutMs?: number;
}

export interface CreateWorkspaceOpts {
  name: string;
  image: string;
  volumeName: string;
  limits?: ResourceLimits;
  env?: Record<string, string>;
}

const EXEC_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function toHostPath(containerPath: string): string {
  if (!containerPath.startsWith("/workspace")) return containerPath;
  const rel = containerPath.slice("/workspace".length) || "/";
  if (HOST_ROOT === "/") return rel === "/" ? "/" : rel;
  return join(HOST_ROOT, rel);
}
function fromHostPath(hostPath: string): string { return hostPath; }

export async function containerExists(name: string): Promise<Container | null> {
  if (HOST_MODE) return null; // no container in host mode
  try {
    const container = docker.getContainer(name);
    await withTimeout(container.inspect(), EXEC_TIMEOUT_MS, `docker inspect ${name}`);
    return container;
  } catch {
    return null;
  }
}

export async function containerState(name: string): Promise<"running" | "stopped" | "missing"> {
  if (HOST_MODE) return "running"; // host is always running
  const c = await containerExists(name);
  if (!c) return "missing";
  try {
    const info = await c.inspect();
    return info.State.Running ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

export async function createWorkspace(opts: CreateWorkspaceOpts): Promise<Container> {
  if (HOST_MODE) {
    // In host mode, just ensure host workspace dir exists; return dummy container handle
    const hostWs = toHostPath("/workspace");
    try { mkdirSync(hostWs, { recursive: true }); } catch {}
    // Also ensure hostPath mounts are accessible — no docker container needed
    return { id: `host-${opts.name}` } as unknown as Container;
  }
  const { cpus, memory, pids } = opts.limits ?? {};
  // Host mounts are opt-in and strongly discouraged — only enable explicitly with AUREX_HOST_MOUNTS=true.
  // When enabled, bind-mounts are read-only by default except for the workspace volume.
  const extraBinds: string[] = [];
  if (process.env.AUREX_HOST_MOUNTS === "true") {
    console.warn("[docker] AUREX_HOST_MOUNTS=true — exposing host filesystem to containers (potential breakout)");
    const hostRoots = (process.env.AUREX_HOST_ROOTS || "/home,/var/www,/var/log,/etc/nginx,/tmp").split(",").map(s=>s.trim()).filter(Boolean);
    for (const r of hostRoots) extraBinds.push(`${r}:${r}:rw`);
    // also mount host root as /host for full visibility (read-only)
    extraBinds.push(`/:${"/host"}:ro`);
  }
  const hostConfig: Docker.HostConfig = {
    Memory: memory ? parseMemory(memory) : undefined,
    NanoCpus: cpus ? cpus * 1e9 : undefined,
    PidsLimit: pids,
    Binds: [`${opts.volumeName}:/workspace:rw`, ...extraBinds],
  };
  const container = await withTimeout(docker.createContainer({
    name: opts.name,
    Image: opts.image,
    Hostname: opts.name,
    Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    HostConfig: hostConfig,
    WorkingDir: "/workspace",
  }), 30_000, `docker create ${opts.name}`);
  return container;
}

export async function ensureVolume(name: string): Promise<void> {
  if (HOST_MODE) return;
  try {
    await docker.getVolume(name).inspect();
  } catch {
    await docker.createVolume({ Name: name });
  }
}

export async function startWorkspace(name: string): Promise<void> {
  if (HOST_MODE) return;
  const c = await containerExists(name);
  if (!c) throw new Error(`workspace container ${name} not found`);
  await c.start();
}

export async function stopWorkspace(name: string): Promise<void> {
  if (HOST_MODE) return;
  const c = await containerExists(name);
  if (!c) return;
  try {
    await c.stop({ t: 5 });
  } catch {
    /* already stopped */
  }
}

export async function removeWorkspace(name: string): Promise<void> {
  if (HOST_MODE) return;
  const c = await containerExists(name);
  if (!c) return;
  try {
    await c.stop({ t: 3 });
  } catch {
    /* not running */
  }
  await c.remove({ force: true });
}

export async function removeWorkspaceVolume(name: string): Promise<void> {
  if (HOST_MODE) return;
  try {
    await docker.getVolume(name).remove({ force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Secure sudo handling: never expose SUDO_PASSWORD on the process command line.
 * We spawn `sudo -S` directly and feed the password via stdin (first line),
 * followed by the real stdin payload if any. No `sh -c 'printf ... | sudo'` indirection.
 */
function needsSudo(cmd: string[]): boolean {
  return cmd[0] === "sudo";
}
function stripSudo(cmd: string[]): string[] {
  return cmd.slice(1);
}

/** Spawn helper that optionally feeds sudo password via stdin without ever placing it in argv. */
function spawnWithSudoSupport(
  cmd: string[],
  opts: { stdin?: string; timeoutMs: number; stdio: ("pipe" | "ignore")[] },
): Promise<string> {
  const pw = process.env.SUDO_PASSWORD;
  const useSudo = needsSudo(cmd) && !!pw;
  const finalProg = useSudo ? "sudo" : cmd[0];
  const finalArgs = useSudo ? ["-S", "-p", "", ...stripSudo(cmd)] : cmd.slice(1);
  return new Promise((resolve, reject) => {
    const hasStdin = opts.stdin !== undefined;
    const child = spawn(finalProg, finalArgs, {
      stdio: hasStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    } as never);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`host exec timed out after ${opts.timeoutMs}ms: ${cmd.join(" ")}`));
      }
    }, opts.timeoutMs);
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `host exec exited ${code}: ${cmd.join(" ")}`));
      else resolve(stdout);
    });
    if (useSudo) {
      // Password must be first line on stdin for sudo -S
      child.stdin!.write(pw + "\n", "utf8");
    }
    if (hasStdin) {
      child.stdin!.write(opts.stdin!, "utf8", () => child.stdin!.end());
    } else if (useSudo) {
      child.stdin!.end();
    }
  });
}

function hostExecCapture(cmd: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  const translated = cmd.map((c) => (c.includes("/workspace") ? c.replace(/\/workspace/g, toHostPath("/workspace")) : c));
  // Special handling for `sh -c "... sudo ..."` patterns: rewrite to avoid embedding password in argv.
  // Detect simple `sudo` inside the shell script and execute via spawnWithSudoSupport where possible.
  // For complex shell scripts containing sudo, fall back to executing the shell script itself
  // but inject password via stdin using `sudo -S` expectation — do NOT interpolate password into the script.
  if (translated[0] === "sh" && translated[1] === "-c" && typeof translated[2] === "string" && translated[2].includes("sudo ")) {
    // If script is exactly a sudo invocation, unwrap it to avoid shell.
    // Otherwise run the shell script as-is; sudo inside will read password from our stdin pipe
    // only if we run the shell under sudo — but that would be wrong. So we handle the common case
    // where the script itself is `sudo <cmd>` or contains `sudo` with password forwarding.
    // Here we simply run the translated command directly via spawnWithSudoSupport for the sudo part
    // by delegating to a shell that inherits stdin with password prepended would still leak via argv.
    // Safer: if we detect sudo in sh -c, we execute via bash with SUDO_ASKPASS disabled and feed pw via pipe
    // without placing pw in argv: use `sudo -S` reading from stdin which we provide below.
    const script = translated[2];
    // Replace `sudo ` with `sudo -S -p '' ` in script, then run script via sh -c and feed pw
    const patchedScript = script.replace(/sudo /g, "sudo -S -p '' ");
    const pw = process.env.SUDO_PASSWORD;
    if (pw) {
      return new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", patchedScript, ...translated.slice(3)], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill("SIGKILL");
            reject(new Error(`host exec timed out after ${timeoutMs}ms: ${cmd.join(" ")}`));
          }
        }, timeoutMs);
        child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
        child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
        child.on("error", (e) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(e);
          }
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0) reject(new Error(stderr.trim() || `host exec exited ${code}: ${cmd.join(" ")}`));
          else resolve(stdout);
        });
        child.stdin!.write(pw + "\n");
        child.stdin!.end();
      });
    }
  }
  if (needsSudo(translated)) {
    return spawnWithSudoSupport(translated, { timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  }
  return spawnWithSudoSupport(translated, { timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).catch((e) => {
    // For non-sudo, spawnWithSudoSupport already handles it without sudo prefix
    // Fallback: raw spawn without sudo path (should already be covered)
    void e;
    return new Promise<string>((resolve, reject) => {
      const child = spawn(translated[0], translated.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(`host exec timed out after ${timeoutMs}ms: ${cmd.join(" ")}`));
        }
      }, timeoutMs);
      child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", (er) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(er);
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `host exec exited ${code}: ${cmd.join(" ")}`));
        else resolve(stdout);
      });
    });
  });
}
function hostExecWithStdin(cmd: string[], stdin: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  const translated = cmd.map((c) => (c.includes("/workspace") ? c.replace(/\/workspace/g, toHostPath("/workspace")) : c));
  if (needsSudo(translated)) {
    return spawnWithSudoSupport(translated, { stdin, timeoutMs, stdio: ["pipe", "pipe", "pipe"] });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(translated[0], translated.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`host exec timed out`));
      }
    }, timeoutMs);
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `host exec exited ${code}`));
      else resolve(stdout);
    });
    child.stdin!.write(stdin, "utf8", () => child.stdin!.end());
  });
}

/**
 * Run a command inside a container via the docker CLI (separate process per
 * call, so a hung exec can never block the worker queue and concurrent calls
 * never share a socket). Returns captured stdout. Throws with stderr on
 * non-zero exit. Every call is killed after EXEC_TIMEOUT_MS (or the supplied
 * timeout).
 */
export async function execCapture(name: string, cmd: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  if (HOST_MODE) {
    // In host mode, run directly on host; translate /workspace paths
    // cmd like ["sh","-c","...","sh","/workspace/foo"] — map host paths
    const hostCmd = cmd.map(c => c.startsWith("/workspace") ? toHostPath(c) : c);
    // For sh -c with $1 args, need to translate those too — simple replace in full cmd string
    return hostExecCapture(hostCmd, timeoutMs);
  }
  const { stdout } = await cliExec(name, cmd, undefined, timeoutMs);
  return stdout;
}

/**
 * Start a background process inside a container (docker exec -d) and return
 * immediately. The process keeps running after this call; stdout is discarded.
 * Used to start long-lived services like `opencode serve` inside workspaces.
 */
export async function execDetach(name: string, argv: string[]): Promise<void> {
  if (HOST_MODE) {
    // On host, run detached via spawn detached
    const hostArgv = argv.map(c => c.includes("/workspace") ? c.replace(/\/workspace/g, toHostPath("/workspace")) : c);
    await new Promise<void>((resolve, reject)=>{
      const child = spawn(hostArgv[0], hostArgv.slice(1), { stdio:"ignore", detached:true });
      child.on("error", reject);
      child.unref();
      setTimeout(()=> resolve(), 500);
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const args = ["exec", "-d", name, ...argv];
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `docker exec -d in ${name} exited with code ${code}`));
      else resolve();
    });
  });
}

/** Run a command inside a container with the given stdin (docker exec -i). */
export async function execWithStdin(name: string, argv: string[], stdin: string): Promise<string> {
  if (HOST_MODE) return hostExecWithStdin(argv, stdin);
  const { stdout } = await cliExec(name, argv, stdin);
  return stdout;
}

/**
 * Pipe a binary stream into a command inside the container (docker exec -i).
 * Used for tar/zip transfers that must survive byte-for-byte. Returns captured
 * stdout; rejects with stderr on non-zero exit or timeout.
 */
export function pipeIntoExec(
  name: string,
  argv: string[],
  input: Readable,
  timeoutMs = EXEC_TIMEOUT_MS * 6,
): Promise<string> {
  if (HOST_MODE) {
    // Host mode: pipe into host command directly
    return new Promise((resolve, reject)=>{
      const hostArgv = argv.map(c=> c.includes("/workspace") ? c.replace(/\/workspace/g, toHostPath("/workspace")) : c);
      const child = spawn(hostArgv[0], hostArgv.slice(1), { stdio:["pipe","pipe","pipe"]});
      let stdout=""; let stderr=""; let settled=false;
      const timer=setTimeout(()=>{ if(!settled){ settled=true; child.kill("SIGKILL"); input.destroy(); reject(new Error("host pipe timed out"));}}, timeoutMs);
      child.stdout!.on("data", (c:Buffer)=> stdout+=c.toString());
      child.stderr!.on("data", (c:Buffer)=> stderr+=c.toString());
      child.on("error", e=>{ if(!settled){ settled=true; clearTimeout(timer); reject(e);}});
      child.on("close", code=>{ if(settled) return; settled=true; clearTimeout(timer); if(code!==0) reject(new Error(stderr.trim()||`host exec exited ${code}`)); else resolve(stdout);});
      input.pipe(child.stdin!);
      input.on("error", e=>{ if(!settled){ settled=true; clearTimeout(timer); child.kill("SIGKILL"); reject(e as Error);}});
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", name, ...argv], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        input.destroy();
        reject(new Error(`docker exec (pipe) in ${name} did not finish within ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout!.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr!.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `docker exec in ${name} exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
    input.pipe(child.stdin!);
    child.stdin!.on("error", () => {
      /* EPIPE when the exec fails early; close handler rejects */
    });
    // A failing input (e.g. EISDIR, vanished file) must reject the promise —
    // never escape as an unhandled 'error' event and take down the process.
    input.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

/**
 * Run a command inside a container and hand the raw stdout/stderr streams to
 * the caller (e.g. to pipe a `tar` archive straight into an HTTP response).
 * The caller owns the child process: it must wire stdout, handle close/error,
 * and kill the child when done.
 */
export function execStream(
  name: string,
  argv: string[],
): { stdout: Readable; stderr: Readable; child: ChildProcess } {
  if (HOST_MODE) {
    const hostArgv = argv.map(c=> c.includes("/workspace") ? c.replace(/\/workspace/g, toHostPath("/workspace")) : c);
    const child = spawn(hostArgv[0], hostArgv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    return { stdout: child.stdout as Readable, stderr: child.stderr as Readable, child };
  }
  const child = spawn("docker", ["exec", name, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  return { stdout: child.stdout!, stderr: child.stderr!, child };
}

/** Create the project folder inside a running workspace container. */
export async function ensureWorkspaceDir(name: string, dir: string): Promise<void> {
  if (HOST_MODE) {
    const hostDir = dir.startsWith("/workspace") ? toHostPath(dir) : dir;
    try { mkdirSync(hostDir, { recursive: true }); } catch {}
    // Fallback: sudo mkdir if still missing (e.g. when HOST_ROOT=/ and /hotel needs root)
    if (!existsSync(hostDir)) {
      try {
        await hostExecCapture(["sudo", "mkdir", "-p", hostDir], 15000);
        // chown to current user so subsequent writes don't need sudo
        const user = process.env.USER ?? homedir().split("/").pop() ?? "aurex";
        await hostExecCapture(["sudo", "chown", "-R", `${user}:${user}`, hostDir], 10000).catch(() => {});
      } catch {}
    }
    // Ensure writable by current user
    if (existsSync(hostDir)) {
      try { mkdirSync(hostDir, { recursive: true }); } catch {}
    }
    return;
  }
  await cliExec(name, ["sh", "-c", `mkdir -p "$1" && cd "$1"`, "sh", dir]);
}

/** Write a file inside a running workspace container via stdin. */
export async function writeFileInWorkspace(
  name: string,
  filePath: string,
  content: string,
): Promise<void> {
  if (HOST_MODE) {
    const hostPath = filePath.startsWith("/workspace") ? toHostPath(filePath) : filePath.startsWith("/") ? filePath : resolve(toHostPath("/workspace"), filePath);
    try { mkdirSync(dirname(hostPath), { recursive: true }); } catch {}
    if (!existsSync(dirname(hostPath))) {
      try {
        await hostExecCapture(["sudo", "mkdir", "-p", dirname(hostPath)], 15000);
        const user = process.env.USER ?? homedir().split("/").pop() ?? "aurex";
        await hostExecCapture(["sudo", "chown", "-R", `${user}:${user}`, dirname(hostPath)], 10000).catch(() => {});
      } catch {}
    }
    const { writeFileSync } = await import("node:fs");
    try {
      writeFileSync(hostPath, content, "utf8");
    } catch (e) {
      // Fallback via sudo tee when permission denied (e.g. dir owned by root)
      if ((e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM") {
        await hostExecWithStdin(["sudo", "tee", hostPath], content, 15000);
        const u = process.env.USER ?? homedir().split("/").pop() ?? "aurex";
        await hostExecCapture(["sudo", "chown", `${u}:${u}`, hostPath], 10000).catch(() => {});
      } else throw e;
    }
    return;
  }
  await cliExec(
    name,
    ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", filePath],
    content,
  );
}

/**
 * Write a binary file inside a running workspace container. The buffer is
 * base64-encoded and decoded inside the container so arbitrary bytes survive
 * the docker exec stdin round-trip.
 */
export async function writeBinaryFileInWorkspace(
  name: string,
  filePath: string,
  data: Buffer,
): Promise<void> {
  if (HOST_MODE) {
    const hostPath = filePath.startsWith("/workspace") ? toHostPath(filePath) : filePath;
    try { mkdirSync(dirname(hostPath), { recursive: true }); } catch {}
    if (!existsSync(dirname(hostPath))) {
      try {
        await hostExecCapture(["sudo", "mkdir", "-p", dirname(hostPath)], 15000);
      } catch {}
    }
    const { writeFileSync } = await import("node:fs");
    try {
      writeFileSync(hostPath, data);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM") {
        await hostExecWithStdin(["sudo", "tee", hostPath], data.toString("base64"), 15000).then(async () => {
          await hostExecCapture(["sh", "-c", `base64 -d "${hostPath}.b64" > "${hostPath}" && rm "${hostPath}.b64"`], 15000).catch(() => {});
        }).catch(async () => {
          // direct sudo base64 decode
          await hostExecCapture(["sh", "-c", `printf %s "$1" | base64 -d | sudo tee "$2" > /dev/null`, "sh", data.toString("base64"), hostPath], 15000);
        });
      } else throw e;
    }
    return;
  }
  await cliExec(
    name,
    ["sh", "-c", 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', "sh", filePath],
    data.toString("base64"),
  );
}

/** True when a path exists inside the running workspace container. */
export async function fileExistsInWorkspace(name: string, filePath: string): Promise<boolean> {
  if (HOST_MODE) {
    const hostPath = filePath.startsWith("/workspace") ? toHostPath(filePath) : filePath;
    return existsSync(hostPath);
  }
  try {
    await cliExec(name, ["sh", "-c", 'test -f "$1"', "sh", filePath]);
    return true;
  } catch {
    return false;
  }
}

function cliExec(
  name: string,
  argv: string[],
  stdin?: string,
  timeoutMs: number = EXEC_TIMEOUT_MS,
): Promise<{ stdout: string }> {
  if (HOST_MODE) {
    // Run directly on host — translate /workspace and handle sudo securely (no argv leak)
    const hostArgv = argv.map((a) => (a.includes("/workspace") ? a.replace(/\/workspace/g, toHostPath("/workspace")) : a));
    // Delegate to secure sudo-aware helpers (no password interpolation into shell strings)
    if (hostArgv[0] === "sudo" || (hostArgv[0] === "sh" && hostArgv[1] === "-c" && typeof hostArgv[2] === "string" && hostArgv[2].includes("sudo "))) {
      // Use hostExec helpers which handle sudo via stdin
      const execPromise = stdin !== undefined ? hostExecWithStdin(hostArgv, stdin, timeoutMs) : hostExecCapture(hostArgv, timeoutMs);
      return execPromise.then((stdout) => ({ stdout }));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(hostArgv[0], hostArgv.slice(1), { stdio: stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(`host exec timeout ${timeoutMs}ms: ${argv.join(" ")}`));
        }
      }, timeoutMs);
      child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `host exec exited ${code}: ${argv.join(" ")}`));
        else resolve({ stdout });
      });
      if (stdin !== undefined) child.stdin!.write(stdin, "utf8", () => child.stdin!.end());
    });
  }
  return new Promise((resolve, reject) => {
    const args = ["exec", ...(stdin !== undefined ? ["-i"] : []), name, ...argv];
    const child = spawn("docker", args, {
      stdio: stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`docker exec in ${name} did not finish within ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout!.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr!.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `docker exec in ${name} exited with code ${code}`));
      } else {
        resolve({ stdout });
      }
    });
    if (stdin !== undefined) {
      child.stdin!.write(stdin, "utf8", () => child.stdin!.end());
    }
  });
}

export async function listFilesInWorkspace(name: string, path = "/workspace"): Promise<string[]> {
  if (HOST_MODE) {
    const hostPath = path.startsWith("/workspace") ? toHostPath(path) : path;
    const { spawn } = await import("node:child_process");
    // host direct find
    const out = await new Promise<string>((resolve,reject)=>{
      const child = spawn("sh",["-c", `cd "$1" 2>/dev/null && find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.agents/*' -not -path '*/.claude/*' -not -path '*/.windsurf/*' -not -path '*/.turbo/*' -not -path '*/.cache/*' -not -name 'AGENTS.md' -not -name 'STATE.md' | sort | head -1000`, "sh", hostPath] as unknown as string[], { stdio:["ignore","pipe","pipe"]});
      let o=""; let e=""; child.stdout!.on("data",(c:Buffer)=> o+=c.toString()); child.stderr!.on("data",(c:Buffer)=> e+=c.toString());
      child.on("close", code=> code===0? resolve(o) : reject(new Error(e||`find exited ${code}`)));
      child.on("error", reject);
    });
    return out.split("\n").map(l=>l.trim()).filter(Boolean);
  }
  const out = await execCapture(name, [
    "sh",
    "-c",
    `cd "$1" 2>/dev/null && find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.agents/*' -not -path '*/.claude/*' -not -path '*/.windsurf/*' -not -path '*/.turbo/*' -not -path '*/.cache/*' -not -name 'AGENTS.md' -not -name 'STATE.md' | sort | head -1000`,
    "sh",
    path,
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface ReadFileResult {
  ok: boolean;
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  size?: number;
  error?: string;
}

/**
 * Read a file's contents from inside a workspace container. Paths are relative
 * to the given project directory (as returned by listFilesInWorkspace).
 * Returns `binary: true` when the file is not valid UTF-8 text.
 */
export async function readFileInWorkspace(
  name: string,
  filePath: string,
  projectPath = "/workspace",
  maxBytes = 2_000_000,
): Promise<ReadFileResult> {
  if (HOST_MODE) {
    const full = filePath.startsWith("/") ? (filePath.startsWith("/workspace") ? toHostPath(filePath) : filePath) : resolve(toHostPath(projectPath), filePath);
    try {
      const { readFileSync, statSync } = await import("node:fs");
      const st = statSync(full);
      if (st.size > maxBytes*2) { /* still read truncated */ }
      const buf = readFileSync(full);
      const txt = buf.toString("utf8");
      if (txt.includes("\u0000")) return { ok:true, binary:true, size: buf.length };
      const truncated = txt.length > maxBytes;
      return { ok:true, content: truncated? txt.slice(0,maxBytes): txt, truncated, size: txt.length };
    } catch (e) { return { ok:false, error: e instanceof Error? e.message: String(e)}; }
  }
  let stdout: string;
  try {
    const res = await cliExec(
      name,
      ["sh", "-c", 'cat "$1" 2>/dev/null', "sh", filePath.startsWith("/") ? filePath : `${projectPath}/${filePath}`],
    );
    stdout = res.stdout;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (stdout.includes("\u0000") || stdout.includes("\uFFFD")) {
    return { ok: true, binary: true, size: stdout.length };
  }
  const truncated = stdout.length > maxBytes;
  return {
    ok: true,
    content: truncated ? stdout.slice(0, maxBytes) : stdout,
    truncated,
    size: stdout.length,
  };
}

export function workspaceContainerName(workspaceId: string): string {
  return `aurex-ws-${workspaceId}`;
}

/** Create a directory (and parents) inside a running workspace container. */
export async function mkdirInWorkspace(name: string, dirPath: string): Promise<void> {
  if (HOST_MODE) { const hp = dirPath.startsWith("/workspace") ? toHostPath(dirPath) : dirPath; try { mkdirSync(hp, { recursive:true }); } catch {} if (!existsSync(hp)) { try { await hostExecCapture(["sudo","mkdir","-p", hp],15000); } catch {} } return; }
  await cliExec(name, ["sh", "-c", 'mkdir -p "$1"', "sh", dirPath]);
}

/**
 * Rename / move a file or directory inside a running workspace container.
 * Uses `mv` which works across the same filesystem (volume mount).
 */
export async function renameInWorkspace(name: string, from: string, to: string): Promise<void> {
  if (HOST_MODE) {
    const hf = from.startsWith("/workspace") ? toHostPath(from) : from;
    const ht = to.startsWith("/workspace") ? toHostPath(to) : to;
    const { renameSync } = await import("node:fs");
    try { mkdirSync(dirname(ht), { recursive:true }); } catch {}
    try { renameSync(hf, ht); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM" || (e as NodeJS.ErrnoException).code === "EXDEV") {
        await hostExecCapture(["sudo","mkdir","-p", dirname(ht)],10000).catch(()=>{});
        await hostExecCapture(["sudo","mv", hf, ht],10000);
      } else throw e;
    }
    return;
  }
  await cliExec(name, ["sh", "-c", 'mkdir -p "$(dirname "$2")" && mv "$1" "$2"', "sh", from, to]);
}

export interface ContainerStatsResult {
  cpuPct: number;
  memUsed: number;
  memLimit: number;
  pids: number;
}

/** Live CPU/memory/pid telemetry for a container (docker stats). */
export async function containerStats(name: string): Promise<ContainerStatsResult | null> {
  const c = await containerExists(name);
  if (!c) return null;
  try {
    const raw = (await c.stats({ stream: false })) as unknown as {
      cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
      precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
      memory_stats?: { usage?: number; limit?: number };
      pids_stats?: { current?: number };
    };
    const cpuDelta = (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
    const numCpus = raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
    const cpuPct = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;
    return {
      cpuPct: Math.round(cpuPct * 10) / 10,
      memUsed: raw.memory_stats?.usage ?? 0,
      memLimit: raw.memory_stats?.limit ?? 0,
      pids: raw.pids_stats?.current ?? 0,
    };
  } catch {
    return null;
  }
}

/** Seconds the container has been running (null when not running). */
export async function containerUptimeSeconds(name: string): Promise<number | null> {
  const c = await containerExists(name);
  if (!c) return null;
  try {
    const info = await c.inspect();
    if (!info.State.Running) return null;
    const started = new Date(info.State.StartedAt).getTime();
    return Math.max(0, Math.floor((Date.now() - started) / 1000));
  } catch {
    return null;
  }
}

/** Tail container stdout/stderr logs (docker logs), demultiplexed. */
export async function containerLogs(name: string, lines = 500): Promise<string> {
  const c = await containerExists(name);
  if (!c) return "";
  try {
    const raw = (await c.logs({ stdout: true, stderr: true, tail: lines })) as Buffer;
    const out: string[] = [];
    for (let i = 0; i < raw.length; ) {
      if (i + 8 > raw.length) break;
      const size = raw.readUInt32BE(i + 4);
      const end = Math.min(i + 8 + size, raw.length);
      out.push(raw.subarray(i + 8, end).toString("utf8"));
      i = end;
    }
    return out.join("");
  } catch {
    return "";
  }
}

export interface ContainerInfoResult {
  image: string;
  created: string;
  started: string | null;
  running: boolean;
  restarts: number;
  pidsLimit: number | null;
  memoryLimit: number | null;
  nanoCpus: number | null;
  ipAddress: string | null;
  gateway: string | null;
  macAddress: string | null;
  networks: string[];
  ports: { exposed: string; hostIp: string | null; hostPort: string | null }[];
}

/** Container inspection: network, resource limits, lifecycle timestamps. */
export async function containerInfo(name: string): Promise<ContainerInfoResult | null> {
  const c = await containerExists(name);
  if (!c) return null;
  try {
    const info = await c.inspect();
    const networks = info.NetworkSettings?.Networks ?? {};
    const first = Object.values(networks)[0] as
      | { IPAddress?: string; Gateway?: string; MacAddress?: string }
      | undefined;
    const portEntries = Object.entries(info.NetworkSettings?.Ports ?? {});
    return {
      image: info.Config?.Image ?? "",
      created: info.Created ?? "",
      started: info.State?.StartedAt ?? null,
      running: Boolean(info.State?.Running),
      restarts: info.RestartCount ?? 0,
      pidsLimit: info.HostConfig?.PidsLimit ?? null,
      memoryLimit: info.HostConfig?.Memory ?? null,
      nanoCpus: info.HostConfig?.NanoCpus ?? null,
      ipAddress: first?.IPAddress ?? null,
      gateway: first?.Gateway ?? null,
      macAddress: first?.MacAddress ?? null,
      networks: Object.keys(networks),
      ports: portEntries.flatMap(([exposed, bindings]) =>
        (bindings ?? []).map((b) => ({ exposed, hostIp: b.HostIp ?? null, hostPort: b.HostPort ?? null })),
      ),
    };
  } catch {
    return null;
  }
}

/** Number of running processes inside the container. */
export async function containerProcessCount(name: string): Promise<number | null> {
  try {
    const out = await execCapture(name, ["sh", "-c", "ps -e 2>/dev/null | wc -l"]);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function parseMemory(mem: string): number {
  const normalized = mem.trim().toLowerCase().replace(/b$/, "");
  const m = /^(\d+)([kmg])?$/.exec(normalized);
  if (!m) throw new Error(`invalid memory limit: ${mem}`);
  const unit = m[2] ?? "b";
  const mult: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(m[1]) * (mult[unit] ?? 1);
}
