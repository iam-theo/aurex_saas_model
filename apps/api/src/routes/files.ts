import { Router, type Request, type Response } from "express";
import { prisma } from "@aurex/db";
import {
  containerState,
  execCapture,
  fileExistsInWorkspace,
  listFilesInWorkspace,
  readFileInWorkspace,
  startWorkspace,
  workspaceContainerName,
  writeFileInWorkspace,
  mkdirInWorkspace,
  renameInWorkspace,
} from "@aurex/docker";
import { projectWorkspacePath, workspaceRunDirectory } from "@aurex/shared";
import { assertProjectAccess, resolveProjectWorkspace } from "../access.js";

/** Sanitize and normalize a relative file path; rejects traversal, null bytes, and encoded dots (including double-encoding). */
function sanitizePath(raw: string): string | null {
  if (raw.includes("\0")) return null;
  let decoded = raw;
  // Decode repeatedly to catch double-encoding like %252e%252e%2f -> %2e%2e%2f -> ../
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  // normalize backslashes, strip leading slashes, collapse //, resolve ./
  const normalized = decoded.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!normalized || normalized.length > 512) return null;
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === "." || seg === "") return null;
    if (seg.length > 255) return null;
    if (/[\x00-\x1f\x7f]/.test(seg)) return null;
  }
  if (normalized.includes("..")) return null;
  return segments.join("/");
}

const router = Router();

/** Base directory inside the container for a project's files. */
function baseDir(
  ws: { projectId: string | null; path: string | null },
  projectName: string,
): string {
  if (ws.projectId != null) return ws.path ?? projectWorkspacePath(projectName);
  return workspaceRunDirectory(ws.path, true, projectName);
}

async function resolve(
  req: Request,
  res: Response,
  projectId: string,
): Promise<{ containerName: string; dir: string } | null> {
  if (!(await assertProjectAccess(req, res, projectId))) return null;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  const ws = await resolveProjectWorkspace(req.user?.id, projectId);
  // In HOST_MODE containerId may be null (dummy host workspace) — still allow
  const hostMode = process.env.AUREX_HOST_MODE === "true" || process.env.AUREX_EXEC_MODE === "host";
  if (!ws || (!ws.containerId && !hostMode)) return null;
  return {
    containerName: workspaceContainerName(ws.id),
    dir: baseDir(ws, project?.name ?? "project"),
  };
}

// List files inside the project's workspace (legacy container or the user's
// personal container, scoped to the project's folder).
router.get("/:projectId", async (req, res, next) => {
  try {
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.json({ containerId: null, files: [] });
      return;
    }
    let files: string[] = [];
    try {
      files = await listFilesInWorkspace(ctx.containerName, ctx.dir);
    } catch {
      /* container may be stopped */
    }
    res.json({ containerId: ctx.containerName, files });
  } catch (e) {
    next(e);
  }
});

// Read a single file's contents from inside the project's workspace.
// ?path=<relative path> (e.g. ./src/App.tsx)
router.get("/:projectId/read", async (req, res, next) => {
  try {
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!rawPath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const sanitized = sanitizePath(rawPath);
    if (sanitized === null) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.status(409).json({ error: "project has no running workspace container" });
      return;
    }
    const result = await readFileInWorkspace(ctx.containerName, sanitized, ctx.dir);
    if (!result.ok) {
      res.status(500).json({ error: result.error ?? "failed to read file" });
      return;
    }
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Start the container if it exists but is stopped (env writes / git need exec).
async function ensureRunning(containerName: string): Promise<void> {
  const state = await containerState(containerName);
  if (state === "stopped") await startWorkspace(containerName);
}

// Read the project's .env file (empty string when none exists yet).
router.get("/:projectId/env", async (req, res, next) => {
  try {
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.status(409).json({ error: "project has no running workspace container" });
      return;
    }
    await ensureRunning(ctx.containerName);
    const exists = await fileExistsInWorkspace(ctx.containerName, `${ctx.dir}/.env`);
    let content = "";
    if (exists) {
      const result = await readFileInWorkspace(ctx.containerName, ".env", ctx.dir);
      content = result.content ?? "";
    }
    res.json({ content });
  } catch (e) {
    next(e);
  }
});

// Write the project's .env file.
router.put("/:projectId/env", async (req, res, next) => {
  try {
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.status(409).json({ error: "project has no running workspace container" });
      return;
    }
    await ensureRunning(ctx.containerName);
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    await writeFileInWorkspace(ctx.containerName, `${ctx.dir}/.env`, content);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Git metadata for the project's workspace (remote, branch, working tree).
router.get("/:projectId/git", async (req, res, next) => {
  try {
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.status(409).json({ error: "project has no running workspace container" });
      return;
    }
    await ensureRunning(ctx.containerName);
    const run = (cmd: string) =>
      execCapture(ctx.containerName, ["sh", "-c", `cd "$1" && ${cmd} 2>/dev/null || true`, "sh", ctx.dir], 8000)
        .then((o) => o.trim())
        .catch(() => "");
    const [remote, branch, rawStatus, aheadBehind] = await Promise.all([
      run("git config --get remote.origin.url"),
      run("git rev-parse --abbrev-ref HEAD"),
      run("git status --porcelain"),
      run("git rev-list --left-right --count HEAD...@{upstream}"),
    ]);
    const files = rawStatus ? rawStatus.split("\n").filter(Boolean) : [];
    const counts = /^\s*(\d+)\s+(\d+)/.exec(aheadBehind);
    res.json({
      remote,
      branch,
      dirty: files.length,
      files: files.slice(0, 100),
      ahead: counts ? Number(counts[1]) : null,
      behind: counts ? Number(counts[2]) : null,
    });
  } catch (e) {
    next(e);
  }
});

// Write a file in the project workspace
router.put("/:projectId/write", async (req, res, next) => {
  try {
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.status(409).json({ error: "project has no running workspace container" });
      return;
    }
    await ensureRunning(ctx.containerName);
    const filePath = typeof req.body?.path === "string" ? req.body.path : "";
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!filePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const normalized = sanitizePath(filePath);
    if (normalized === null) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    if (content.length > 2_000_000) {
      res.status(413).json({ error: "file too large (max 2 MB)" });
      return;
    }
    const fullPath = `${ctx.dir}/${normalized}`;
    await writeFileInWorkspace(ctx.containerName, fullPath, content);
    // Verify realpath stays inside project dir (symlink containment)
    const real = await execCapture(ctx.containerName, ["sh", "-c", 'realpath -m -- "$1" 2>/dev/null || echo "$1"', "sh", fullPath]).catch(() => fullPath);
    const realTrim = real.trim();
    // realpath -m resolves symlinks + .. — must start with ctx.dir + "/"
    if (realTrim !== fullPath && !realTrim.startsWith(ctx.dir + "/") && realTrim !== ctx.dir) {
      await execCapture(ctx.containerName, ["sh", "-c", 'rm -f -- "$1"', "sh", fullPath]).catch(() => {});
      res.status(400).json({ error: "path escapes project directory (symlink)" });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Create a directory inside the project workspace.
router.post("/:projectId/mkdir", async (req, res, next) => {
  try {
    const rawPath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!rawPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const normalized = sanitizePath(rawPath);
    if (normalized === null) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.status(409).json({ error: "project has no running workspace container" });
      return;
    }
    await ensureRunning(ctx.containerName);
    await mkdirInWorkspace(ctx.containerName, `${ctx.dir}/${normalized}`);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Rename / move a file or directory inside the project workspace.
router.post("/:projectId/rename", async (req, res, next) => {
  try {
    const rawFrom = typeof req.body?.from === "string" ? req.body.from : "";
    const rawTo = typeof req.body?.to === "string" ? req.body.to : "";
    if (!rawFrom || !rawTo) {
      res.status(400).json({ error: "from and to are required" });
      return;
    }
    const from = sanitizePath(rawFrom);
    const to = sanitizePath(rawTo);
    if (from === null || to === null) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.status(409).json({ error: "project has no running workspace container" });
      return;
    }
    await ensureRunning(ctx.containerName);
    await renameInWorkspace(ctx.containerName, `${ctx.dir}/${from}`, `${ctx.dir}/${to}`);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Delete a file or directory from the project workspace.
// ?path=<relative path>
router.delete("/:projectId", async (req, res, next) => {
  try {
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!rawPath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const normalized = sanitizePath(rawPath);
    if (normalized === null) {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) {
      res.status(409).json({ error: "project has no running workspace container" });
      return;
    }
    await ensureRunning(ctx.containerName);
    const fullPath = `${ctx.dir}/${normalized}`;
    // Verify the target exists before attempting removal.
    const exists = await fileExistsInWorkspace(ctx.containerName, fullPath);
    if (!exists) {
      // Also check for directory (fileExistsInWorkspace only checks files).
      const isDir = await execCapture(
        ctx.containerName,
        ["sh", "-c", '[ -d "$1" ] && echo yes || echo no', "sh", fullPath],
      ).then((o) => o.trim() === "yes").catch(() => false);
      if (!isDir) {
        res.status(404).json({ error: "file not found" });
        return;
      }
    }
    await execCapture(
      ctx.containerName,
      ["sh", "-c", 'rm -rf "$1"', "sh", fullPath],
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
