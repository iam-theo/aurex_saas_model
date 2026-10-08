/**
 * Attachment handling + model modality capabilities shared by the API, worker
 * and web app. Mirrors the models.dev modality catalog for the opencode Zen
 * models Aurex exposes; anything not listed defaults to text-only so we never
 * promise vision a model cannot deliver.
 */

export type AttachmentModality = "image" | "pdf" | "text";

export interface AttachmentInfo {
  id: string;
  name: string;
  storedPath: string;
  mime: string;
  size: number;
}

export interface ModelCapabilities {
  /** Native image (vision) input support. */
  image: boolean;
  /** Native application/pdf input support. */
  pdf: boolean;
}

export const ATTACHMENTS_SUBDIR = ".aurex/attachments";

/**
 * Vision-capable default used when a run/chat message includes an image but
 * the selected model cannot see images natively.
 */
export const DEFAULT_VISION_MODEL = "opencode/kimi-k2.5-free";

export const ALLOWED_ATTACHMENT_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
] as const;

export function attachmentModality(mime: string): AttachmentModality {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  return "text";
}

/** Absolute path inside the workspace container where an attachment lives. */
export function attachmentContainerPath(directory: string, attachmentId: string, name: string): string {
  return `${directory}/${ATTACHMENTS_SUBDIR}/${attachmentId}/${name}`;
}

/**
 * Model input capabilities. Free opencode Zen models that accept images are
 * listed explicitly; paid BYOK providers (OpenAI/Anthropic/Google) accept
 * images and PDFs. Everything else is text-only.
 */
const VISION_IMAGE_MODELS = new Set([
  // OpenCode Zen models
  "kimi-k2.5-free",
  "kimi-k2.5",
  "kimi-k2.7",
  "kimi-k2.7-code",
  "qwen3.5-plus",
  "qwen3.6-plus",
  "qwen3.6-plus-free",
  "mimo-v2.5-free",
  "minimax-m3",
  "minimax-m3-free",
]);

const NATIVE_PDF_MODELS = new Set([
  // OpenCode paid models
  "gemini-3-pro",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-3-5-haiku",
]);

/** Extract the bare model id from a `provider/model` string. */
export function modelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash === -1 || slash === model.length - 1 ? model : model.slice(slash + 1);
}

export function modelProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash <= 0 ? "opencode" : model.slice(0, slash);
}

export function modelCapabilities(model: string): ModelCapabilities {
  const provider = modelProvider(model).toLowerCase();
  const id = modelName(model).toLowerCase();

  // BYOK providers always support image and PDF
  if (provider === "openai" || provider === "anthropic" || provider === "google" || provider === "gemini") {
    return { image: true, pdf: true };
  }

  // OpenCode models - check against bare model name
  const image = VISION_IMAGE_MODELS.has(id);
  const pdf = NATIVE_PDF_MODELS.has(id);
  return { image, pdf };
}

/** Short human label for an attachment, e.g. "photo.png (image)". */
export function attachmentLabel(info: Pick<AttachmentInfo, "name" | "mime">): string {
  return `${info.name} (${attachmentModality(info.mime)})`;
}
