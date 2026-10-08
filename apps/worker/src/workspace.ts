import { prisma, type Prisma } from "@aurex/db";
import {
  createWorkspace,
  ensureVolume,
  ensureWorkspaceDir,
  writeFileInWorkspace,
  startWorkspace,
  stopWorkspace,
  containerState,
  workspaceContainerName,
  type ResourceLimits,
} from "@aurex/docker";
import { projectWorkspacePath, WORKSPACE_ROOT } from "@aurex/shared";
import { AUREX_AGENT_SYSTEM_PROMPT, AUREX_AGENT_FILE } from "@aurex/shared/agent-prompt";
import { WORKSPACE_IMAGE } from "./config.js";

async function ensureProjectFolder(workspace: {
  id: string;
  projectId: string | null;
  ownerId: string | null;
  path: string | null;
}, containerName: string): Promise<string> {
  // Personal per-user containers root at /workspace; each project gets its own
  // subfolder that the run creates.
  if (workspace.projectId == null) {
    const path = workspace.path || WORKSPACE_ROOT;
    await ensureWorkspaceDir(containerName, path);
    if (workspace.path !== path) {
      await prisma.workspace.update({ where: { id: workspace.id }, data: { path } });
    }
    return path;
  }
  const project = await prisma.project.findUnique({ where: { id: workspace.projectId } });
  const path = workspace.path ?? projectWorkspacePath(project?.name ?? workspace.id);
  await ensureWorkspaceDir(containerName, path);
  await writeFileInWorkspace(containerName, `${path}/${AUREX_AGENT_FILE}`, AUREX_AGENT_SYSTEM_PROMPT);
  if (workspace.path !== path) {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { path },
    });
  }
  return path;
}

export async function ensureWorkspace(workspaceId: string, limits?: ResourceLimits) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);

  const name = workspaceContainerName(workspace.id);
  const volumeName = `aurex-vol-${workspace.id}`;
  const state = await containerState(name);

  if (state === "missing") {
    await ensureVolume(volumeName);
    const container = await createWorkspace({
      name,
      image: workspace.image || WORKSPACE_IMAGE,
      volumeName,
      limits,
    });
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        containerId: container.id,
        status: "starting",
        resourceLimits: (limits ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    await startWorkspace(name);
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: "running" },
    });
  } else if (state === "stopped") {
    await startWorkspace(name);
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: "running" },
    });
  } else {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: "running" },
    });
  }
  await ensureProjectFolder(workspace, name);
  return name;
}

export async function startWorkspaceById(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
  const name = workspaceContainerName(workspace.id);
  const state = await containerState(name);
  if (state === "missing") {
    throw new Error("workspace container not created yet; call ensure first");
  }
  if (state === "stopped") {
    await startWorkspace(name);
  }
  await ensureProjectFolder(workspace, name);
  await prisma.workspace.update({ where: { id: workspace.id }, data: { status: "running" } });
}

export async function stopWorkspaceById(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
  const name = workspaceContainerName(workspace.id);
  await stopWorkspace(name);
  await prisma.workspace.update({ where: { id: workspace.id }, data: { status: "stopped" } });
}
