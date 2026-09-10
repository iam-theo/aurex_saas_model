import { Router, type Request, type Response } from "express";
import multer from "multer";
import { prisma } from "@aurex/db";
import {
  containerState,
  execStream,
  writeBinaryFileInWorkspace,
  workspaceContainerName,
  fileExistsInWorkspace,
} from "@aurex/docker";
import {
  ALLOWED_ATTACHMENT_MIMES,
  attachmentContainerPath,
  attachmentModality,
  projectWorkspacePath,
  workspaceRunDirectory,
} from "@aurex/shared";
import { assertProjectAccess, resolveProjectWorkspace } from "../access.js";
import { ensurePersonalWorkspace } from "../auth.js";
import { workspaceQueue, WORKSPACE_JOB } from "../queue.js";

const router = Router();

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB
const CONTAINER_READY_POLL_MS = 1000;
const CONTAINER_READY_POLLS = 45;

// Disk storage to avoid holding large files in Node heap (OOM on concurrent uploads)
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, file, cb) => cb(null, `aurex-attach-${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`),
  }),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

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
): Promise<{ containerName: string; dir: string; workspaceId: string } | null> {
  if (!(await assertProjectAccess(req, res, projectId))) return null;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  // Mirrors runs.ts: prefer a legacy per-project workspace, else the user's
  // personal workspace (created on demand even when auth is disabled).
  let ws = await prisma.workspace.findUnique({ where: { projectId } });
  if (!ws) {
    const { AUTH_ENABLED } = await import("../auth.js");
    if (!req.user?.id && AUTH_ENABLED) return null;
    ws = await ensurePersonalWorkspace(req.user?.id ?? "");
    if (!ws || (ws.ownerId ?? "") === "") return null;
  }
  const dir = baseDir(ws, project?.name ?? "project");
  return { containerName: workspaceContainerName(ws.id), dir, workspaceId: ws.id };
}

/**
 * Ensure the workspace container is running so files can be written into it.
 * If it is missing/stopped we enqueue the provisioning job and poll for the
 * container to come up (the worker performs the actual create/start).
 */
async function ensureContainerReady(containerName: string, workspaceId: string): Promise<void> {
  const state = await containerState(containerName);
  if (state === "missing" || state === "stopped") {
    await workspaceQueue
      .add(WORKSPACE_JOB.Ensure, { workspaceId }, { removeOnComplete: 100, removeOnFail: 100 })
      .catch(() => undefined);
  }
  for (let i = 0; i < CONTAINER_READY_POLLS; i++) {
    if ((await containerState(containerName)) === "running") return;
    await new Promise((r) => setTimeout(r, CONTAINER_READY_POLL_MS));
  }
  throw new Error("workspace container did not become ready in time; try again in a moment");
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, "").trim();
  return (cleaned || "file").slice(0, 120);
}

function validateMime(mime: string): string | null {
  const m = ALLOWED_ATTACHMENT_MIMES.find((allowed) => allowed === mime);
  return m ?? null;
}

// Upload a file into the project's workspace. The bytes are persisted into the
// container immediately so a later run can reference them by path.
router.post("/:projectId", upload.single("file"), async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "a file upload is required (multipart field 'file')" });
      return;
    }
    const mime = validateMime(file.mimetype);
    if (!mime) {
      res.status(415).json({
        error: `unsupported file type: ${file.mimetype}. Allowed: images (png/jpeg/webp/gif), PDF, txt, md`,
      });
      return;
    }
    const ctx = await resolve(req, res, req.params.projectId);
    if (!ctx) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      res.status(413).json({ error: "file exceeds the 15 MB upload limit" });
      return;
    }

    await ensureContainerReady(ctx.containerName, ctx.workspaceId);

    const id = crypto.randomUUID();
    const name = safeFileName(file.originalname);
    const storedPath = attachmentContainerPath(ctx.dir, id, name);
    const { readFile, unlink } = await import("node:fs/promises");
    const buf = await readFile(file.path);
    try {
      await writeBinaryFileInWorkspace(ctx.containerName, storedPath, buf);
    } finally {
      await unlink(file.path).catch(() => {});
    }

    const attachment = await prisma.agentAttachment.create({
      data: {
        id,
        projectId: req.params.projectId,
        name,
        storedPath,
        mime,
        size: file.size,
      },
    });
    res.status(201).json({
      attachment: {
        id: attachment.id,
        name: attachment.name,
        storedPath: attachment.storedPath,
        mime: attachment.mime,
        size: attachment.size,
        modality: attachmentModality(attachment.mime),
      },
    });
  } catch (e) {
    next(e);
  }
});

// List attachments that belong to a project (used by the run composer).
router.get("/:projectId/attachments", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.projectId))) return;
    const rows = await prisma.agentAttachment.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, name: true, storedPath: true, mime: true, size: true, runId: true, createdAt: true },
    });
    res.json({
      attachments: rows.map((a) => ({ ...a, modality: attachmentModality(a.mime) })),
    });
  } catch (e) {
    next(e);
  }
});

// Stream an attachment's bytes back out of the container (e.g. image preview).
router.get("/:projectId/attachments/:attachmentId", async (req, res, next) => {
  try {
    const { projectId, attachmentId } = req.params;
    if (!(await assertProjectAccess(req, res, projectId))) return;
    const attachment = await prisma.agentAttachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, name: true, storedPath: true, mime: true, projectId: true },
    });
    if (!attachment || attachment.projectId !== projectId) {
      res.status(404).json({ error: "attachment not found" });
      return;
    }
    const ctx = await resolve(req, res, projectId);
    if (!ctx) return;
    if (!(await fileExistsInWorkspace(ctx.containerName, attachment.storedPath))) {
      res.status(404).json({ error: "attachment file no longer exists in the workspace" });
      return;
    }
    res.setHeader("Content-Type", attachment.mime);
    res.setHeader("Content-Disposition", `inline; filename="${attachment.name.replace(/"/g, "")}"`);
    const { stdout, stderr, child } = execStream(ctx.containerName, [
      "sh",
      "-c",
      `cat "$1"`,
      "sh",
      attachment.storedPath,
    ]);
    stdout.pipe(res);
    child.on("close", (code) => {
      if (!res.headersSent && code !== 0) res.status(500).end();
      res.end();
    });
    stderr.resume();
  } catch (e) {
    next(e);
  }
});

export default router;
