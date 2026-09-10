import type { Request, Response } from "express";
import { prisma } from "@aurex/db";
import { AUTH_ENABLED } from "./auth.js";

/**
 * Ownership rules:
 * - When auth is disabled the platform is open (all requests pass through).
 * - When auth is enabled, a project/workspace/run is only accessible to its
 *   owner. Legacy rows with a null owner are hidden from everyone.
 */

export function canAccess(ownerId: string | null | undefined, userId: string | undefined): boolean {
  if (!AUTH_ENABLED) return true; // open (pre-auth) mode
  return Boolean(ownerId) && ownerId === userId;
}

export async function assertProjectAccess(
  req: Request,
  res: Response,
  projectId: string,
): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  if (!project) {
    res.status(404).json({ error: "project not found" });
    return false;
  }
  if (!canAccess(project.ownerId, req.user?.id)) {
    res.status(403).json({ error: "you do not have access to this project" });
    return false;
  }
  return true;
}

export async function assertRunAccess(
  req: Request,
  res: Response,
  runId: string,
): Promise<boolean> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { project: { select: { ownerId: true } } },
  });
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return false;
  }
  if (!canAccess(run.project.ownerId, req.user?.id)) {
    res.status(403).json({ error: "you do not have access to this run" });
    return false;
  }
  return true;
}

/**
 * A workspace is accessible if it is a personal workspace owned by the user,
 * or a legacy per-project workspace whose project belongs to the user.
 */
export async function assertWorkspaceAccess(
  req: Request,
  res: Response,
  workspaceId: string,
): Promise<boolean> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) {
    res.status(404).json({ error: "workspace not found" });
    return false;
  }
  if (!AUTH_ENABLED) return true;
  let ownerId = ws.ownerId;
  if (ws.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: ws.projectId },
      select: { ownerId: true },
    });
    ownerId = project?.ownerId ?? null;
  }
  if (!canAccess(ownerId, req.user?.id)) {
    res.status(403).json({ error: "you do not have access to this workspace" });
    return false;
  }
  return true;
}

/** Resolve the workspace a project's work runs in: the project's own legacy
 * workspace if one exists, otherwise the user's personal workspace. */
export async function resolveProjectWorkspace(
  userId: string | undefined,
  projectId: string,
): Promise<{ id: string; projectId: string | null; ownerId: string | null; path: string | null; status: string; containerId: string | null } | null> {
  const own = await prisma.workspace.findUnique({
    where: { projectId },
    select: { id: true, projectId: true, ownerId: true, path: true, status: true, containerId: true },
  });
  if (own) return own;
  if (!userId) return null;
  return prisma.workspace.findUnique({
    where: { ownerId: userId },
    select: { id: true, projectId: true, ownerId: true, path: true, status: true, containerId: true },
  });
}
