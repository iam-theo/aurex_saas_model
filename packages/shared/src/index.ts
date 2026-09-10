export const DEFAULT_MODEL = "opencode/big-pickle";

export const RUN_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;

export const WORKSPACE_ROOT = "/workspace";

export { AUREX_AGENT_SYSTEM_PROMPT, AUREX_AGENT_FILE } from "./agent-prompt.js";

// Prompt system
export {
  loadPromptFile,
  discoverPrompts,
  getPrompt,
  getCorePrompts,
  composeSystemPrompt,
  detectTaskCategories,
  getCapabilityPromptIds,
  getWorkflowForTask,
  buildSystemPromptForTask,
  CORE_PROMPT_IDS,
  ALL_PROMPTS,
  type PromptMeta,
} from "./prompts/prompts.js";
export {
  ATTACHMENTS_SUBDIR,
  ALLOWED_ATTACHMENT_MIMES,
  DEFAULT_VISION_MODEL,
  attachmentModality,
  attachmentContainerPath,
  attachmentLabel,
  modelName,
  modelProvider,
  modelCapabilities,
  type AttachmentInfo,
  type AttachmentModality,
  type ModelCapabilities,
} from "./attachments.js";

// AureXtra free models
export {
  AUREXTRA_MODELS,
  AUTO_MODEL_ID,
  CATEGORY_INFO,
  CATEGORY_PRIORITY,
  DEFAULT_MODEL_PER_CATEGORY,
  getModelsByCategory,
  getModelById,
  getModelsByCategories,
  autoSelectModel,
  type AureXtraModel,
  type ModelCategory,
} from "./openrouter-models.js";

// AureXtra API client utilities
export {
  OPENROUTER_API_BASE,
  isOpenRouterModel,
  extractOpenRouterModelId,
  createOpenRouterCompletion,
  streamOpenRouterCompletion,
  fetchOpenRouterFreeModels,
  type OpenRouterMessage,
  type OpenRouterRequest,
  type OpenRouterResponse,
} from "./openrouter.js";

// Artifact system
export {
  detectImageGenerationRequest,
  stripImageGenerationMarker,
  artifactFilename,
  imageMimeType,
  type ArtifactType,
  type ArtifactStatus,
  type Artifact,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ArtifactEventData,
} from "./artifacts.js";

// Turn a project name into a filesystem-safe folder name, e.g.
// "BIBLE QUIZ" -> "bible-quiz", "EALERT" -> "ealert".
export function projectFolder(name: string): string {  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "project";
}

export function projectWorkspacePath(name: string): string {
  return `${WORKSPACE_ROOT}/${projectFolder(name)}`;
}

/**
 * Directory an agent run operates in. Legacy per-project workspaces use the
 * workspace path as-is (single project per container). Personal workspaces (one
 * container per user) hold one subfolder per project.
 */
export function workspaceRunDirectory(
  workspacePath: string | null | undefined,
  personal: boolean,
  projectName: string,
): string {
  const base = workspacePath || WORKSPACE_ROOT;
  if (!personal) return base;
  return `${base}/${projectFolder(projectName)}`;
}

// Import Project feature
export {
  IMPORT_LIMITS,
  sanitizeImportPath,
  stripCommonRoot,
  assertWithinLimits,
  ImportLimitError,
  initialImportSteps,
  type ImportMode,
  type ImportStatus,
  type ImportStep,
  type ImportStepKey,
} from "./import.js";
export {
  detectProject,
  agentContextBlock,
  type DetectedProject,
  type DetectedCommands,
} from "./project-detect.js";

export type ProjectStatus = "active" | "archived";

export type WorkspaceStatus = "created" | "starting" | "running" | "stopped" | "error";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout";

export type AgentEventType =
  | "step_start"
  | "message"
  | "text"
  | "reasoning"
  | "tool"
  | "step_finish"
  | "question"
  | "question_reply"
  | "error"
  | "system"
  | "artifact";

/** One choice offered by the model's question tool. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** A single question within a question request. */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** A `question.asked` event relayed from the workspace agent. */
export interface QuestionRequestData {
  requestId: string;
  sessionId?: string;
  sessionID?: string;
  questions: QuestionInfo[];
}

export interface AgentEventData {
  id: string;
  runId: string;
  seq: number;
  type: AgentEventType;
  data: unknown;
  createdAt: string;
}

export interface RunSummary {
  id: string;
  projectId: string;
  workspaceId: string | null;
  provider: string;
  model: string;
  task: string;
  status: RunStatus;
  exitCode: number | null;
  error: string | null;
  result: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  id: string;
  projectId: string;
  containerId: string | null;
  image: string;
  status: WorkspaceStatus;
  resourceLimits: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInfo {
  id: string;
  provider: string;
  label: string;
  builtin: boolean;
  local: boolean;
}
