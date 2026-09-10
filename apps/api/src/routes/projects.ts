import { Router } from "express";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@aurex/db";
import {
  containerState,
  execStream,
  removeWorkspace,
  removeWorkspaceVolume,
  startWorkspace,
  workspaceContainerName,
} from "@aurex/docker";
import { projectWorkspacePath, workspaceRunDirectory } from "@aurex/shared";
import { removePublishedSite, rollbackPublishedSite, ensurePublishSetup, unpublishProject } from "../publish.js";
import { enqueuePublish } from "../queue.js";
import { assertProjectAccess, resolveProjectWorkspace } from "../access.js";
import { AUTH_ENABLED, ensurePersonalWorkspace } from "../auth.js";

const router = Router();

function runChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let err = "";
    if (child.stderr) {
      child.stderr.on("data", (c: Buffer) => {
        err += c.toString();
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(err.trim() || `process exited with code ${code}`));
    });
  });
}

router.get("/", async (req, res, next) => {
  try {
    const projects = await prisma.project.findMany({
      where: AUTH_ENABLED ? { ownerId: req.user?.id } : {},
      orderBy: { createdAt: "desc" },
      include: { workspace: true, _count: { select: { runs: true } } },
    });

    res.json(projects);
    // Fire-and-forget status sync (don't block response). In HOST_MODE, containerState is always "running".
    if (AUTH_ENABLED && req.user?.id && process.env.AUREX_HOST_MODE !== "true" && process.env.AUREX_EXEC_MODE !== "host") {
      void (async () => {
        try {
          const ws = await prisma.workspace.findFirst({ where: { ownerId: req.user!.id } });
          if (ws && ws.status !== "destroyed") {
            const state = await containerState(workspaceContainerName(ws.id));
            if (state === "missing") {
              await prisma.workspace.update({ where: { id: ws.id }, data: { status: "destroyed", containerId: null } }).catch(() => undefined);
            }
          }
        } catch {}
      })();
    }
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, description } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (name.trim().length < 2 || name.trim().length > 80) {
      res.status(400).json({ error: "name must be 2–80 characters" });
      return;
    }
    if (description && typeof description === "string" && description.length > 2000) {
      res.status(400).json({ error: "description too large (max 2000 chars)" });
      return;
    }
    // A destroyed dev container must be respawned before new work is created.
    if (AUTH_ENABLED && req.user?.id) {
      const ws = await ensurePersonalWorkspace(req.user.id);
      const state = await containerState(workspaceContainerName(ws.id));
      if (state === "missing") {
        res.status(409).json({ error: "workspace_destroyed", workspaceId: ws.id });
        return;
      }
    }
    const project = await prisma.project.create({
      data: { name, description: description ?? null, ownerId: req.user?.id ?? null },
    });
    res.status(201).json(project);
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.id))) return;
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        workspace: true,
        runs: { orderBy: { createdAt: "desc" }, take: 50 },
      },
    });
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    res.json(project);
  } catch (e) {
    next(e);
  }
});

router.get("/:id/export", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.id))) return;
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, description: true, status: true, publishedUrl: true, publishedAt: true, createdAt: true, updatedAt: true },
    });
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    const ws = await resolveProjectWorkspace(req.user?.id, project.id);
    if (!ws) {
      res.status(400).json({ error: "project has no workspace" });
      return;
    }
    const name = workspaceContainerName(ws.id);
    const state = await containerState(name);
    if (state === "missing") {
      res.status(400).json({ error: "workspace container no longer exists" });
      return;
    }
    if (state === "stopped") await startWorkspace(name);

    const dir =
      ws.projectId != null
        ? ws.path ?? projectWorkspacePath(project.name)
        : workspaceRunDirectory(ws.path, true, project.name);
    const slug = dir.split("/").filter(Boolean).pop() ?? project.name;
    const safeName = project.name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "project";
    const EXCLUDES = [
      "*/node_modules",
      "*/.git",
      "*/dist",
      "*/build",
      "*/out",
      "*/.next",
      "*/.nuxt",
      "*/.output",
      "*/.cache",
      "*/.turbo",
      "*/.vercel",
      "*/.netlify",
      "*/.vinxi",
      "*/.expo",
      "*/.env",
      "*/.env.*",
      "*/.env.local",
      "*/.env.production",
      "*.pyc",
      "*/__pycache__",
      "*/.DS_Store",
      "*/Thumbs.db",
      "*/.vscode",
      "*/.idea",
      "*.log",
      "*.tgz",
      "*.tar.gz",
      "*/.sass-cache",
      "*/coverage",
      "*/.nyc_output",
      "*.tsbuildinfo",
      "*/.parcel-cache",
      "*/.vite",
      "*/.docker",
      "*/Dockerfile*",
      "*/docker-compose*",
    ].map((p) => `--exclude='${p}'`).join(" ");

    const tmpDir = await mkdtemp(join(tmpdir(), "aurex-export-"));
    const cleanup = () => rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

    try {
      // 1. Stream the code out of the container (no node_modules/.git) and
      //    extract it into a host temp dir.
      const tar = execStream(name, [
        "sh",
        "-c",
        `cd /workspace && tar cf - ${EXCLUDES} "${slug}"`,
      ]);
      const extract = spawn("tar", ["xf", "-", "-C", tmpDir], { stdio: ["pipe", "ignore", "pipe"] });
      tar.stdout.pipe(extract.stdin);
      const results = await Promise.allSettled([runChild(tar.child), runChild(extract)]);
      if (results.some((r) => r.status === "rejected")) {
        await cleanup();
        res.status(500).json({ error: "failed to read workspace files" });
        return;
      }

      // 2. Zip it up on the host.
      const zipPath = join(tmpDir, `${safeName}-code.zip`);
      await runChild(spawn("zip", ["-rq", zipPath, slug], { cwd: tmpDir, stdio: ["ignore", "ignore", "pipe"] }));

      // 3. Stream the zip to the client, then clean up.
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-code.zip"`);
      const rs = createReadStream(zipPath);
      rs.pipe(res);
      rs.on("error", () => {
        void cleanup();
        if (!res.headersSent) res.status(500).json({ error: "failed to export codebase" });
        else res.end();
      });
      const finish = () => void cleanup();
      res.on("finish", finish);
      res.on("close", finish);
    } catch (e) {
      await cleanup();
      next(e);
    }
  } catch (e) {
    next(e);
  }
});

router.post("/check-subdomain", async (req, res, next) => {
  try {
    const { subdomain, projectId } = req.body ?? {};
    if (!subdomain || typeof subdomain !== "string") {
      res.status(400).json({ error: "subdomain is required" });
      return;
    }
    const slug = subdomain
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (!slug || slug.length < 2) {
      res.json({ available: false, reason: "too short" });
      return;
    }
    const RESERVED = ["api", "www", "mail", "admin", "app", "dashboard", "docs", "status", "health", "auth"];
    if (RESERVED.includes(slug)) {
      res.json({ available: false, reason: "reserved" });
      return;
    }
    const existing = await prisma.project.findFirst({
      where: {
        subdomain: slug,
        ...(projectId ? { NOT: { id: projectId } } : {}),
      },
      select: { id: true },
    });
    res.json({ available: !existing, slug });
  } catch (e) {
    next(e);
  }
});

// Check / ensure publish infrastructure is set up (nginx helper, tunnel).
router.post("/publish/setup", async (req, res, next) => {
  try {
    const result = await ensurePublishSetup();
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/publish", async (req, res, next) => {
  try {
    const internalKey = process.env.AUREX_INTERNAL_KEY;
    const isInternal = Boolean(internalKey && req.headers["x-aurex-internal"] === internalKey);
    if (!isInternal && !(await assertProjectAccess(req, res, req.params.id))) return;
    const { slug } = req.body ?? {};
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    // Fast-path: change detection before enqueue — surface no_changes as 409
    if (project.publishedUrl && project.subdomain) {
      const latestRun = await prisma.agentRun.findFirst({
        where: { projectId: req.params.id, status: "completed" },
        orderBy: { completedAt: "desc" },
        select: { id: true },
      });
      if (!latestRun || latestRun.id === project.lastPublishedRunId) {
        res.status(409).json({ error: "no_changes", message: "No new changes to publish. The current live version matches the latest completed run." });
        return;
      }
    }
    // Check if a publish is already in progress
    if (project.publishStatus && project.publishProgress != null && project.publishProgress > 0 && project.publishProgress < 100) {
      res.status(409).json({ error: "publish_in_progress", message: "A publish is already in progress" });
      return;
    }
    await prisma.project.update({
      where: { id: req.params.id },
      data: { publishStatus: "Queued…", publishProgress: 2 },
    }).catch(() => {});
    await enqueuePublish(req.params.id, req.user?.id, slug);
    res.status(202).json({ accepted: true, status: "queued" });
  } catch (e) {
    if (e instanceof Error && e.message === "no_changes") {
      res.status(409).json({ error: "no_changes", message: "No new changes to publish." });
      return;
    }
    next(e);
  }
});

// Manual reset for stuck publishes (clears progress so UI can retry)
router.post("/:id/publish/reset", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.id))) return;
    await prisma.project.update({ where: { id: req.params.id }, data: { publishStatus: null, publishProgress: null } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Unpublish - takes down URL, clears DB, stops backend, removes nginx+webroot+cloudflared ingress
// After this, Publish again restarts the full publishing process (no no_changes block)
router.post("/:id/unpublish", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.id))) return;
    const result = await unpublishProject(req.params.id, req.user?.id);
    res.json(result);
  } catch (e) {
    if (e instanceof Error && e.message === "not_published") {
      res.status(400).json({ error: "not_published", message: "Project is not published" });
      return;
    }
    next(e);
  }
});

// Rollback a published site to its previous version (from backup).
router.post("/:id/publish/rollback", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.id))) return;
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project?.subdomain) {
      res.status(400).json({ error: "project is not published" });
      return;
    }
    const result = await rollbackPublishedSite(project.subdomain);
    if (!result.restored) {
      res.status(404).json({ error: "no backup available to restore" });
      return;
    }
    res.json({ ok: true, backup: result.backup });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.id))) return;
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { workspace: true },
    });
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    // Legacy per-project workspace: the container/volume belong solely to this
    // project, so remove them. Personal workspaces are shared — only delete the
    // project's folder inside the volume, never the container itself.
    if (project.workspace) {
      await removeWorkspace(workspaceContainerName(project.workspace.id));
      await removeWorkspaceVolume(`aurex-vol-${project.workspace.id}`);
    } else if (req.user?.id) {
      const ws = await prisma.workspace.findUnique({ where: { ownerId: req.user.id } });
      if (ws) {
        const { execCapture } = await import("@aurex/docker");
        const containerName = workspaceContainerName(ws.id);
        const dir = ws.path
          ? `${ws.path}/${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"}`
          : `/workspace/${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"}`;
        await execCapture(containerName, ["sh", "-c", 'rm -rf -- "$1"', "sh", dir]).catch(() => undefined);
      }
    }
    await removePublishedSite(project.name).catch(() => undefined);
    await prisma.project.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
