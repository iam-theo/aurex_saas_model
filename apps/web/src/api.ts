const API = "/api";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  subdomain: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  publishStatus: string | null;
  publishProgress: number | null;
  createdAt: string;
  updatedAt: string;
  workspace?: Workspace | null;
  _count?: { runs: number };
  runs?: Run[];
}

export interface Workspace {
  id: string;
  projectId: string;
  containerId: string | null;
  image: string;
  status: string;
  resourceLimits: Record<string, unknown> | null;
  path: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  workspaceId: string | null;
  provider: string;
  model: string;
  task: string;
  sessionId: string | null;
  status: string;
  exitCode: number | null;
  error: string | null;
  result: string | null;
  promptId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  provider: string;
  label: string;
  builtin: boolean;
  local: boolean;
  isDefault?: boolean;
  image?: boolean;
  pdf?: boolean;
}

export interface PromptMeta {
  id: string;
  category: "core" | "capability" | "workflow";
  name: string;
  description: string;
  keywords: string[];
  file: string;
}

export interface AgentEventView {
  seq: number;
  type: string;
  data: {
    type?: string;
    role?: string;
    text?: string;
    part?: {
      type?: string;
      text?: string;
      reason?: string;
      tool?: string;
      state?: {
        input?: Record<string, unknown>;
        output?: string;
        title?: string;
        status?: string;
        metadata?: { exit?: number; output?: string; truncated?: boolean };
      };
    };
    requestId?: string;
    questions?: QuestionInfo[];
    answers?: string[][];
    rejected?: boolean;
    error?: string;
  };
  createdAt: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  storedPath: string;
  mime: string;
  size: number;
  runId?: string | null;
  modality?: "image" | "pdf" | "text";
  createdAt?: string;
}

export interface Artifact {
  id: string;
  projectId: string | null;
  runId: string | null;
  messageId: string | null;
  type: string;
  mimeType: string;
  filename: string;
  storageKey: string;
  size: number;
  width: number | null;
  height: number | null;
  status: string;
  error: string | null;
  metadata: Record<string, unknown> | null;
  prompt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Display a model identifier without leaking its internal provider prefix.
// "opencode/big-pickle" -> "big-pickle"
export function displayModel(model: string): string {
  const slash = model.lastIndexOf("/");
  if (slash === -1 || slash === model.length - 1) return model;
  return model.slice(slash + 1);
}

export interface ImportStepView {
  key: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  at?: string;
}

export interface ImportStatus {
  id: string;
  projectId: string;
  projectName: string;
  mode: string;
  status: string;
  error: string | null;
  steps: ImportStepView[] | null;
  detected: Record<string, unknown> | null;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => req<Project[]>("/projects"),
  createProject: (name: string, description?: string) =>
    req<Project>("/projects", { method: "POST", body: JSON.stringify({ name, description }) }),
  getProject: (id: string) => req<Project>(`/projects/${id}`),
  exportCodeUrl: (id: string) => `/api/projects/${id}/export`,
  publishProject: (id: string, slug?: string) =>
    req<{ url: string }>(`/projects/${id}/publish`, { method: "POST", body: JSON.stringify({ slug }) }),
  unpublishProject: (id: string) =>
    req<{ ok: boolean; slug?: string }>(`/projects/${id}/unpublish`, { method: "POST", body: JSON.stringify({}) }),
  rollbackPublish: (id: string) =>
    req<{ ok: boolean; backup?: string }>(`/projects/${id}/publish/rollback`, { method: "POST", body: JSON.stringify({}) }),
  ensurePublishSetup: () =>
    req<{ ok: boolean; details: string }>("/projects/publish/setup", { method: "POST", body: JSON.stringify({}) }),
  checkSubdomain: (subdomain: string, projectId?: string) =>
    req<{ available: boolean; slug?: string; reason?: string }>("/projects/check-subdomain", {
      method: "POST",
      body: JSON.stringify({ subdomain, projectId }),
    }),
  deleteProject: (id: string) =>
    req<void>(`/projects/${id}`, { method: "DELETE" }),
  ensureWorkspace: (projectId: string) =>
    req<Workspace>(`/workspaces/${projectId}/ensure`, { method: "POST", body: JSON.stringify({}) }),
  getMyWorkspace: () => req<Workspace>("/workspaces/me"),
  ensureMyWorkspace: () =>
    req<Workspace>("/workspaces/ensure", { method: "POST", body: JSON.stringify({}) }),
  startWorkspace: (id: string) =>
    req<{ status: string }>(`/workspaces/${id}/start`, { method: "POST" }),
  stopWorkspace: (id: string) =>
    req<{ status: string }>(`/workspaces/${id}/stop`, { method: "POST" }),
  getWorkspace: (id: string) => req<Workspace & { runs?: Run[] }>(`/workspaces/${id}`),
  getWorkspaceStatus: (id: string) =>
    req<{
      id: string;
      status: string;
      containerId: string | null;
      image: string;
      path: string | null;
      resourceLimits: Record<string, unknown> | null;
      stats: { cpuPct: number; memUsed: number; memLimit: number; pids: number } | null;
      uptimeSeconds: number | null;
      processes: number | null;
      info: {
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
      } | null;
    }>(`/workspaces/${id}/status`),
  getWorkspaceLogs: (id: string, lines = 300) =>
    req<{ logs: string }>(`/workspaces/${id}/logs?lines=${lines}`),
  destroyWorkspace: (id: string) =>
    req<{ ok: boolean; status: string }>(`/workspaces/${id}/destroy`, { method: "POST", body: JSON.stringify({}) }),
  updateWorkspaceLimits: (id: string, limits: { cpus?: number; memory?: string; pids?: number }) =>
    req<{ ok: boolean; resourceLimits: Record<string, unknown> }>(`/workspaces/${id}/limits`, {
      method: "PUT",
      body: JSON.stringify(limits),
    }),
  listWorkspaceFiles: (id: string) =>
    req<{ containerId: string | null; files: string[] }>(`/workspaces/${id}/files`),
  readWorkspaceFile: (id: string, path: string) =>
    req<{
      ok: boolean;
      content?: string;
      binary?: boolean;
      truncated?: boolean;
      size?: number;
      error?: string;
    }>(`/workspaces/${id}/files/read?path=${encodeURIComponent(path)}`),
  createRun: (projectId: string, task: string, model?: string, attachmentIds?: string[], promptId?: string) =>
    req<Run>("/runs", {
      method: "POST",
      body: JSON.stringify({ projectId, task, model, attachmentIds, promptId }),
    }),
  getRun: (id: string) => req<Run & { events?: AgentEventView[] }>(`/runs/${id}`),
  sendRunMessage: (id: string, text: string, attachmentIds?: string[]) =>
    req<{ ok: boolean }>(`/runs/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, attachmentIds }),
    }),
  listRunAttachments: (id: string) =>
    req<{ attachments: Attachment[] }>(`/runs/${id}/attachments`),
  uploadAttachment: (projectId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return req<{ attachment: Attachment }>(`/files/${projectId}`, {
      method: "POST",
      body: form,
      headers: undefined,
    });
  },
  listAttachments: (projectId: string) =>
    req<{ attachments: Attachment[] }>(`/files/${projectId}/attachments`),
  attachmentUrl: (projectId: string, id: string) => `${API}/files/${projectId}/attachments/${id}`,
  answerRunQuestion: (id: string, requestId: string, answers: string[][]) =>
    req<{ ok: boolean }>(`/runs/${id}/questions`, {
      method: "POST",
      body: JSON.stringify({ requestId, answers }),
    }),
  listModels: () => req<ModelInfo[]>("/models"),
  listFiles: (projectId: string) =>
    req<{ containerId: string | null; files: string[] }>(`/files/${projectId}`),
  readFile: (projectId: string, path: string) =>
    req<{
      ok: boolean;
      content?: string;
      binary?: boolean;
      truncated?: boolean;
      size?: number;
      error?: string;
    }>(`/files/${projectId}/read?path=${encodeURIComponent(path)}`),
  getProjectEnv: (projectId: string) => req<{ content: string }>(`/files/${projectId}/env`),
  saveProjectEnv: (projectId: string, content: string) =>
    req<{ ok: boolean }>(`/files/${projectId}/env`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  getProjectGit: (projectId: string) =>
    req<{
      remote: string;
      branch: string;
      dirty: number;
      files: string[];
      ahead: number | null;
      behind: number | null;
    }>(`/files/${projectId}/git`),
  writeFile: (projectId: string, path: string, content: string) =>
    req<{ ok: boolean }>(`/files/${projectId}/write`, { method: "PUT", body: JSON.stringify({ path, content }) }),
  deleteFile: (projectId: string, path: string) =>
    req<{ ok: boolean }>(`/files/${projectId}?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  createFolder: (projectId: string, path: string) =>
    req<{ ok: boolean }>(`/files/${projectId}/mkdir`, { method: "POST", body: JSON.stringify({ path }) }),
  renameFile: (projectId: string, from: string, to: string) =>
    req<{ ok: boolean }>(`/files/${projectId}/rename`, { method: "POST", body: JSON.stringify({ from, to }) }),
  abortRun: (id: string) =>
    req<{ ok: boolean }>(`/runs/${id}/abort`, { method: "POST", body: JSON.stringify({}) }),
  retryRun: (id: string) =>
    req<{ ok: boolean; status: string }>(`/runs/${id}/retry`, { method: "POST", body: JSON.stringify({}) }),
  previewUrl: (projectId: string, port: number) => `/api/preview/${projectId}/${port}/`,
  authStatus: () =>
    req<{
      configured: boolean;
      authenticated: boolean;
      user: { id: string; email: string; name: string | null; avatarUrl: string | null } | null;
      redirectUri: string | null;
    }>("/auth/status"),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST", body: JSON.stringify({}) }),

  // Artifact methods
  listArtifacts: (projectId: string) =>
    req<Artifact[]>(`/files/${projectId}/artifacts`),
  getArtifact: (projectId: string, artifactId: string) =>
    req<Artifact>(`/files/${projectId}/artifacts/${artifactId}`),
  artifactUrl: (projectId: string, artifactId: string) =>
    `/api/files/${projectId}/artifacts/${artifactId}/file`,
  artifactDownloadUrl: (projectId: string, artifactId: string) =>
    `/api/files/${projectId}/artifacts/${artifactId}/file?download=1`,
  deleteArtifact: (projectId: string, artifactId: string) =>
    req<void>(`/files/${projectId}/artifacts/${artifactId}`, { method: "DELETE" }),

  // Prompt system
  listPrompts: () => req<{ prompts: PromptMeta[] }>("/prompts"),
  getPrompt: (id: string) => req<{ id: string; meta: PromptMeta; content: string }>(`/prompts/${id}`),
  getPromptContent: (id: string) => req<string>(`/prompts/${id}/content`),

  getConfig: () => req<{ publishDomain: string; publicBaseUrl: string | null }>("/config"),

  // Codebase import
  importInit: (mode: "zip" | "folder", name: string) =>
    req<{ importId: string; projectId: string; workspaceId: string; steps: ImportStepView[] }>("/import/init", {
      method: "POST",
      body: JSON.stringify({ mode, name }),
    }),
  importUploadBatch: (importId: string, entries: { path: string; file: File }[], onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append("meta", JSON.stringify(entries.map((e, i) => ({ i, path: e.path }))));
    entries.forEach((e, i) => form.append(`f${i}`, e.file, e.file.name));
    return upload<{ ok: boolean; receivedFiles: number; receivedBytes: number }>(
      `/import/${importId}/batch`,
      form,
      onProgress,
    );
  },
  importUploadZip: (importId: string, file: File, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return upload<{ ok: boolean; receivedBytes: number }>(`/import/${importId}/zip`, form, onProgress);
  },
  importComplete: (importId: string) =>
    req<{
      ok: boolean;
      projectId: string;
      projectName: string;
      detected: Record<string, unknown> | null;
      fileCount: number;
    }>(`/import/${importId}/complete`, { method: "POST", body: JSON.stringify({}) }),
  importStatus: (importId: string) => req<ImportStatus>(`/import/${importId}`),
  importCancel: (importId: string) =>
    req<{ ok: boolean }>(`/import/${importId}/cancel`, { method: "POST", body: JSON.stringify({}) }),
};

/** XHR POST with upload progress (fetch has no upload progress support). */
function upload<T>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}${path}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: { error?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error body */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new Error(body?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(form);
  });
}
