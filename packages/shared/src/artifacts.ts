// Aurex Artifact types and utilities
// Generic artifact system for generated assets (images, audio, video, etc.)

export type ArtifactType = "image" | "audio" | "video" | "document" | "code" | "archive" | "spreadsheet" | "presentation";
export type ArtifactStatus = "pending" | "processing" | "completed" | "failed";

export interface Artifact {
  id: string;
  projectId?: string | null;
  runId?: string | null;
  messageId?: string | null;
  type: ArtifactType;
  mimeType: string;
  filename: string;
  storageKey: string;
  size: number;
  width?: number | null;
  height?: number | null;
  status: ArtifactStatus;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  prompt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  style?: string;
  format?: "png" | "jpeg" | "webp";
  metadata?: Record<string, unknown>;
}

export interface ImageGenerationResult {
  success: boolean;
  artifact?: Artifact;
  error?: string;
}

// Artifact event data emitted via SSE
export interface ArtifactEventData {
  artifact: Artifact;
  action: "created" | "updated" | "completed" | "failed";
}

// Detect image generation intent in agent text output
// Pattern: [GENERATE_IMAGE: <prompt>] or [AUREX_IMAGE: <prompt>]
const IMAGE_GEN_PATTERN = /\[(?:GENERATE_IMAGE|AUREX_IMAGE):\s*(.+?)\]/i;

export function detectImageGenerationRequest(text: string): ImageGenerationRequest | null {
  const match = text.match(IMAGE_GEN_PATTERN);
  if (!match?.[1]) return null;

  const raw = match[1].trim();
  // Try to parse as JSON first (structured request)
  try {
    const parsed = JSON.parse(raw);
    return {
      prompt: parsed.prompt ?? raw,
      negativePrompt: parsed.negative_prompt,
      width: parsed.width,
      height: parsed.height,
      style: parsed.style,
      format: parsed.format,
      metadata: parsed.metadata,
    };
  } catch {
    // Use as plain prompt
    return { prompt: raw };
  }
}

// Strip the image generation marker from text for display
export function stripImageGenerationMarker(text: string): string {
  return text.replace(IMAGE_GEN_PATTERN, "").trim();
}

// Generate a filename for an artifact
export function artifactFilename(type: ArtifactType, mimeType: string, prompt?: string): string {
  const slug = prompt
    ? prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40)
    : "generated";
  const ext = mimeType.split("/")[1] ?? type;
  return `${slug}.${ext}`;
}

// Determine MIME type from format
export function imageMimeType(format?: string): string {
  switch (format) {
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}
