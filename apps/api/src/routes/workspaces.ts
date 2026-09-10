import { Router } from "express";
import { prisma } from "@aurex/db";
import { workspaceQueue, WORKSPACE_JOB } from "../queue.js";
import { assertWorkspaceAccess } from "../access.js";
import { ensurePersonalWorkspace } from "../auth.js";
import {
  containerInfo,
  containerLogs,
  containerProcessCount,
  containerState,
  containerStats,
  containerUptimeSeconds,
  listFilesInWorkspace,
  readFileInWorkspace,
  removeWorkspace,
  removeWorkspaceVolume,
  workspaceContainerName,
} from "@aurex/docker";
import { removePublishedSite } from "../publish.js";

const router = Router();

// The signed-in user's personal workspace (created + provisioned on login).
router.get("/me", async (req, res, next) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    const ws = await ensurePersonalWorkspace(req.user.id);
    res.json(ws);
  } catch (e) {
    next(e);
  }
});

// Ensure the signed-in user's personal workspace container exists.
router.post("/ensure", async (req, res, next) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    const workspace = await ensurePersonalWorkspace(req.user.id);
    const resourceLimits = req.body?.resourceLimits ?? workspace.resourceLimits ?? {
      cpus: 2,
      memory: "4g",
      pids: 512,
      timeoutMs: 600000,
    };
    await workspaceQueue.add(
      WORKSPACE_JOB.Ensure,
      { workspaceId: workspace.id, resourceLimits },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
    res.status(202).json(workspace);
  } catch (e) {
    next(e);
  }
});

// Back-compat alias used by the old Project page: ensure the user's personal
// workspace (the projectId is only used for an ownership check).
router.post("/:projectId/ensure", async (req, res, next) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    const workspace = await ensurePersonalWorkspace(req.user.id);
    const resourceLimits = req.body?.resourceLimits ?? workspace.resourceLimits ?? {
      cpus: 2,
      memory: "4g",
      pids: 512,
      timeoutMs: 600000,
    };
    await workspaceQueue.add(
      WORKSPACE_JOB.Ensure,
      { workspaceId: workspace.id, resourceLimits },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
    res.status(202).json(workspace);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/start", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    await workspaceQueue.add(WORKSPACE_JOB.Start, { workspaceId: req.params.id }, {
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    res.status(202).json({ status: "starting" });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/stop", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    await workspaceQueue.add(WORKSPACE_JOB.Stop, { workspaceId: req.params.id }, {
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    res.status(202).json({ status: "stopping" });
  } catch (e) {
    next(e);
  }
});

// Update the desired resource limits for a workspace. These are stored in the
// database and applied the next time the container is created (ensure/respawn).
router.put("/:id/limits", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
    if (!ws) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    const { cpus, memory, pids } = req.body ?? {};
    const current = (ws.resourceLimits as Record<string, unknown>) ?? {};
    const updated: Record<string, unknown> = { ...current };
    if (cpus !== undefined) updated.cpus = Number(cpus) || 2;
    if (memory !== undefined) updated.memory = String(memory || "4g");
    if (pids !== undefined) updated.pids = Number(pids) || 512;
    await prisma.workspace.update({
      where: { id: req.params.id },
      data: { resourceLimits: updated as any },
    });
    res.json({ ok: true, resourceLimits: updated });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.id },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 20 } },
    });
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    res.json(workspace);
  } catch (e) {
    next(e);
  }
});

// Live container status + telemetry (state, uptime, cpu, memory, image, network).
// When the container is missing, automatically clean up orphaned projects.
router.get("/:id/status", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
    if (!ws) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    const name = workspaceContainerName(ws.id);
    const state = await containerState(name);

    // Non-destructive: mark destroyed so UI can prompt respawn. Projects are
    // never deleted on a GET — explicit POST /:id/destroy is required.
    if (state === "missing" && ws.status !== "destroyed") {
      await prisma.workspace
        .update({ where: { id: ws.id }, data: { status: "destroyed", containerId: null } })
        .catch(() => undefined);
    }

    const [stats, uptimeSeconds, info, processes] = await Promise.all([
      state === "running" ? containerStats(name) : Promise.resolve(null),
      state === "running" ? containerUptimeSeconds(name) : Promise.resolve(null),
      state !== "missing" ? containerInfo(name) : Promise.resolve(null),
      state === "running" ? containerProcessCount(name) : Promise.resolve(null),
    ]);
    res.json({
      id: ws.id,
      status: state === "missing" ? "destroyed" : state,
      containerId: ws.containerId,
      image: ws.image,
      path: ws.path,
      resourceLimits: ws.resourceLimits,
      stats,
      uptimeSeconds,
      info,
      processes,
    });
  } catch (e) {
    next(e);
  }
});

// Tail the workspace container's stdout/stderr logs. ?lines=200
router.get("/:id/logs", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
    if (!ws) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    const lines = Math.min(Math.max(Number(req.query.lines) || 300, 10), 2000);
    const name = workspaceContainerName(ws.id);
    const logs = (await containerLogs(name, lines)).split("\n").slice(-lines).join("\n");
    res.json({ logs });
  } catch (e) {
    next(e);
  }
});

// Destroy the container for real (docker rm -f) and delete every project in
// this workspace entirely (projects, runs, events, attachments, the shared
// volume and any published site). The workspace row itself is kept so a fresh
// dev container can be respawned before the next project is created.
router.post("/:id/destroy", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
    if (!ws) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    const name = workspaceContainerName(ws.id);

    // The projects that live in this workspace: for a personal workspace, every
    // project owned by the user that has no dedicated workspace of its own
    // (i.e. its work runs inside this container); otherwise the workspace's own
    // project.
    const projects = ws.projectId
      ? await prisma.project.findMany({ where: { id: ws.projectId } })
      : ws.ownerId
        ? await prisma.project.findMany({ where: { ownerId: ws.ownerId, workspace: { is: null } } })
        : [];

    // 1. Remove the container for real.
    await removeWorkspace(name);

    // 2. Delete each project entirely (cascades runs -> events, attachments)
    //    and remove any published site from the host webroot.
    for (const p of projects) {
      await removePublishedSite(p.name).catch(() => undefined);
      await prisma.project.delete({ where: { id: p.id } });
    }

    // 3. Remove the shared volume (project files + attachments on disk).
    await removeWorkspaceVolume(`aurex-vol-${ws.id}`).catch(() => undefined);

    // 4. For legacy per-project workspaces the project delete cascaded the row;
    //    for the personal workspace keep the record so it can be respawned.
    await prisma.workspace
      .update({ where: { id: ws.id }, data: { status: "destroyed", containerId: null } })
      .catch(() => undefined);

    res.json({ ok: true, status: "destroyed", projectsDeleted: projects.length });
  } catch (e) {
    next(e);
  }
});

// File listing for the workspace root (the whole /workspace volume).
router.get("/:id/files", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
    if (!ws) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    const name = workspaceContainerName(ws.id);
    const state = await containerState(name);
    if (state !== "running") {
      res.json({ containerId: null, files: [] });
      return;
    }
    const files = await listFilesInWorkspace(name, "/workspace");
    res.json({ containerId: name, files });
  } catch (e) {
    next(e);
  }
});

// Read a single file from the workspace root. ?path=./src/index.ts
router.get("/:id/files/read", async (req, res, next) => {
  try {
    if (!(await assertWorkspaceAccess(req, res, req.params.id))) return;
    const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
    if (!ws) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (!path) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const name = workspaceContainerName(ws.id);
    const result = await readFileInWorkspace(name, path, "/workspace");
    if (!result.ok) {
      res.status(500).json({ error: result.error ?? "failed to read file" });
      return;
    }
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
