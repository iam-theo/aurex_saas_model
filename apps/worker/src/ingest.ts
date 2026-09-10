import { execCapture } from "@aurex/docker";
import {
  AUTO_MODEL_ID,
  autoSelectModel,
  DEFAULT_VISION_MODEL,
  attachmentModality,
  modelCapabilities,
  type AttachmentInfo,
  type AttachmentModality,
} from "@aurex/shared";

/**
 * Turns a task + attachments into the `parts[]` array sent to the agent
 * session. Attachments become native `file` parts when the selected model can
 * consume the modality, and are extracted to text (tesseract OCR / pdftotext)
 * otherwise so even text-only models can read them.
 */

/**
 * Resolve the actual model to use. Handles:
 * - "aurextra/auto" -> auto-select best model for the task
 * - Vision fallback when the chosen model can't handle images
 */
export function resolveModel(model: string, task: string, attachments: AttachmentInfo[]): string {
  // Auto-select: analyze task and pick the best category model
  if (model === AUTO_MODEL_ID || model === "openrouter/aurextra/auto") {
    const selection = autoSelectModel(task);
    // provider-qualified ids (e.g. "opencode/x-preview-f-free") pass through as-is
    model = selection.model.startsWith("opencode/") ? selection.model : `openrouter/${selection.model}`;
  }

  // Vision fallback: if there are images and the model can't see them
  const hasImage = attachments.some((a) => attachmentModality(a.mime) === "image");
  if (hasImage && !modelCapabilities(model).image) {
    return DEFAULT_VISION_MODEL;
  }

  return model;
}

/**
 * @deprecated Use resolveModel instead. Kept for backward compatibility.
 */
export function effectiveModelFor(model: string, attachments: AttachmentInfo[]): string {
  const hasImage = attachments.some((a) => attachmentModality(a.mime) === "image");
  if (hasImage && !modelCapabilities(model).image) return DEFAULT_VISION_MODEL;
  return model;
}

export interface PromptTextPart {
  type: "text";
  text: string;
}

export interface PromptFilePart {
  type: "file";
  mime: string;
  filename: string;
  url: string;
}

export type PromptPart = PromptTextPart | PromptFilePart;

const MAX_EXTRACTED_CHARS = 60_000;
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS ?? 90_000);

function extractedTextPart(att: AttachmentInfo, modality: AttachmentModality, text: string): PromptTextPart {
  const kind =
    modality === "pdf"
      ? "PDF document"
      : modality === "image"
        ? "image (text extracted via OCR)"
        : "document";
  const header = `[Contents of attached ${kind} "${att.name}" (${att.size} bytes)]`;
  if (!text.trim()) {
    return {
      type: "text",
      text: `${header}\n\nNo text could be extracted automatically from this file. If the image contains important visual detail, switch to a vision-capable model.`,
    };
  }
  const truncated = text.length > MAX_EXTRACTED_CHARS;
  const body = truncated ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
  const suffix = truncated
    ? `\n\n[Extracted text truncated: ${text.length - MAX_EXTRACTED_CHARS} more characters not shown]`
    : "";
  return { type: "text", text: `${header}\n\n${body}${suffix}` };
}

/** Extract text from a PDF via poppler; falls back to per-page OCR when the
 * PDF is scanned (no embedded text layer). */
async function extractPdfText(containerName: string, path: string): Promise<string> {
  try {
    const text = await execCapture(
      containerName,
      ["sh", "-c", `pdftotext -layout "$1" - 2>/dev/null`, "sh", path],
      EXTRACT_TIMEOUT_MS,
    );
    if (text.trim().length >= 120) return text.trim();
  } catch {
    /* fall through to OCR */
  }
  try {
    return await execCapture(
      containerName,
      [
        "sh",
        "-c",
        `d=$(mktemp -d) && pdftoppm -png -r 150 "$1" "$d/pg" 2>/dev/null; ` +
          `for f in "$d"/pg-*.png; do [ -f "$f" ] || continue; tesseract "$f" stdout 2>/dev/null; echo; done; ` +
          `rm -rf "$d"`,
        "sh",
        path,
      ],
      EXTRACT_TIMEOUT_MS,
    );
  } catch {
    return "";
  }
}

/** OCR an image with tesseract. `--psm 6` assumes a uniform block of text and
 * produces cleaner output for screenshots; falls back to auto for photos. */
async function extractImageText(containerName: string, path: string): Promise<string> {
  try {
    const psm6 = await execCapture(
      containerName,
      ["sh", "-c", `tesseract "$1" stdout --psm 6 2>/dev/null`, "sh", path],
      EXTRACT_TIMEOUT_MS,
    );
    if (psm6.trim().length >= 40) return psm6.trim();
  } catch {
    /* try auto */
  }
  try {
    return await execCapture(
      containerName,
      ["sh", "-c", `tesseract "$1" stdout 2>/dev/null`, "sh", path],
      EXTRACT_TIMEOUT_MS,
    );
  } catch {
    return "";
  }
}

async function readTextFile(containerName: string, path: string): Promise<string> {
  try {
    return await execCapture(containerName, ["sh", "-c", `cat "$1"`, "sh", path], EXTRACT_TIMEOUT_MS);
  } catch {
    return "";
  }
}

export async function buildPromptParts(opts: {
  containerName: string;
  task: string;
  attachments: AttachmentInfo[];
  model: string;
}): Promise<PromptPart[]> {
  const { containerName, task, attachments, model } = opts;
  const caps = modelCapabilities(model);
  const parts: PromptPart[] = [{ type: "text", text: task }];

  // Separate native (no extraction) from needs-extraction to parallelize the slow OCR/pdf work
  const nativeParts: PromptPart[] = [];
  const extractJobs: Array<Promise<PromptPart>> = [];
  for (const att of attachments) {
    const modality = attachmentModality(att.mime);
    const native = modality === "image" ? caps.image : modality === "pdf" ? caps.pdf : true;
    if (native) {
      nativeParts.push({ type: "file", mime: att.mime, filename: att.name, url: `file://${att.storedPath}` });
    } else {
      extractJobs.push(
        (async () => {
          const text =
            modality === "pdf"
              ? await extractPdfText(containerName, att.storedPath)
              : modality === "image"
                ? await extractImageText(containerName, att.storedPath)
                : await readTextFile(containerName, att.storedPath);
          return extractedTextPart(att, modality, text);
        })(),
      );
    }
  }
  const extracted = extractJobs.length > 0 ? await Promise.all(extractJobs) : [];
  parts.push(...nativeParts, ...extracted);
  return parts;
}
