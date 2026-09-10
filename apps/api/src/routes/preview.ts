import { Router } from "express";
import { execStream, workspaceContainerName } from "@aurex/docker";
import { assertProjectAccess, resolveProjectWorkspace } from "../access.js";

const router = Router();

// Preview proxy: streams a port inside the workspace container back to the
// browser. curl writes the HTTP status/headers to stderr (-D /dev/stderr) so the
// stdout body stays byte-exact (important for images/assets).
router.get("/:projectId/:port/*", async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const port = Number(req.params.port);
    // Wildcard path (incl. query string): everything after /:projectId/:port.
    const prefix = `/api/preview/${projectId}/${req.params.port}`;
    const rawPath = req.originalUrl.slice(prefix.length).replace(/^\/+/, "");
    // block path traversal / absolute URLs and strip query for validation
    const cleanPath = rawPath.split("?")[0].split("#")[0];
    if (cleanPath.includes("..") || cleanPath.includes("//") || /^[a-z]+:\/\//i.test(rawPath)) {
      res.status(400).json({ error: "invalid preview path" });
      return;
    }
    const path = rawPath;
    const ALLOWED_PREVIEW_PORTS = new Set(
      (process.env.AUREX_PREVIEW_PORTS ?? "3000,3001,4000,4001,4002,4003,4096,5000,5173,5174,8000,8080,9000")
        .split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
    );
    // Also allow deterministic per-slug backend 4000-4999 range
    const inDynamicRange = port >= 4000 && port <= 4999;
    if (!Number.isInteger(port) || (!ALLOWED_PREVIEW_PORTS.has(port) && !inDynamicRange)) {
      res.status(400).json({ error: "port not allowed for preview" });
      return;
    }
    if (!(await assertProjectAccess(req, res, projectId))) return;

    const ws = await resolveProjectWorkspace(req.user?.id, projectId);
    if (!ws) {
      res.status(404).json({ error: "project has no workspace" });
      return;
    }
    const containerName = workspaceContainerName(ws.id);
    const url = `http://127.0.0.1:${port}/${path.replace(/^\/+/, "")}`;

    const { stdout, stderr, child } = execStream(containerName, [
      "sh",
      "-c",
      `curl -sS --max-time 25 -o - -D /dev/stderr "$1"`,
      "sh",
      url,
    ]);

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let resolved = false;
    let totalBytes = 0;
    const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

    const fail = () => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill();
      } catch {
        /* already closed */
      }
      if (!res.headersSent) res.status(502).json({ error: "preview unavailable" });
      else res.end();
    };

    const finish = () => {
      if (resolved) return;
      resolved = true;
      const body = Buffer.concat(outChunks);
      const head = Buffer.concat(errChunks).toString("utf8");

      const lines = head.split("\r\n");
      const statusLine = lines.find((l) => /^HTTP\/\d/.test(l));
      // curl writes the error to stderr (e.g. "curl: (7) Failed to connect"),
      // and no HTTP status line means nothing is listening on that port.
      if (!statusLine) {
        if (!res.headersSent) res.status(502).json({ error: "preview unavailable" });
        else res.end();
        return;
      }
      const statusCode = Number(statusLine.split(" ")[1]) || 200;
      const contentType =
        lines
          .find((l) => /^content-type:/i.test(l))
          ?.split(":")
          .slice(1)
          .join(":")
          .trim() ?? "text/html";

      res.status(statusCode).type(contentType);
      res.send(body);
    };

    req.on("close", () => {
      if (!resolved) {
        resolved = true;
        try {
          child.kill();
        } catch {
          /* already closed */
        }
      }
    });

    stdout.on("data", (c: Buffer) => {
      totalBytes += c.length;
      if (totalBytes > MAX_PREVIEW_BYTES) {
        try { child.kill(); } catch {}
        if (!resolved) {
          resolved = true;
          if (!res.headersSent) res.status(413).json({ error: "preview response too large" });
          else res.end();
        }
        return;
      }
      outChunks.push(c);
    });
    stderr.on("data", (c: Buffer) => errChunks.push(c));
    stdout.on("error", fail);
    stderr.on("error", fail);
    child.on("error", fail);

    let outEnded = false;
    let errEnded = false;
    const maybeFinish = () => {
      if (outEnded && errEnded) finish();
    };
    stdout.on("end", () => {
      outEnded = true;
      maybeFinish();
    });
    stderr.on("end", () => {
      errEnded = true;
      maybeFinish();
    });
  } catch (e) {
    next(e);
  }
});

export default router;
