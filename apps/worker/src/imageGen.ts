// Image generation capability using Pollinations.ai (free, no API key)
import { prisma } from "@aurex/db";
import {
  detectImageGenerationRequest,
  stripImageGenerationMarker,
  artifactFilename,
  imageMimeType,
  type ImageGenerationRequest,
  type Artifact,
} from "@aurex/shared";
import { publishRunEvent, nextRunSeq } from "./pubsub.js";
import { API_URL, INTERNAL_KEY } from "./config.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const IMAGE_STORAGE_DIR = process.env.IMAGE_STORAGE_DIR ?? "/tmp/aurex-artifacts";
const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";

// Ensure storage directory exists
async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(IMAGE_STORAGE_DIR, { recursive: true });
}

// Generate image via Pollinations.ai
async function generateWithPollinations(
  prompt: string,
  width: number,
  height: number,
): Promise<Buffer> {
  // Truncate prompt to ~250 chars to avoid Pollinations.ai errors on long prompts
  const truncated = prompt.length > 250 ? prompt.slice(0, 250) : prompt;
  const encoded = encodeURIComponent(truncated);
  const url = `${POLLINATIONS_BASE}/${encoded}?width=${width}&height=${height}&nologo=true&seed=${Date.now()}`;

  console.log(`[aurex-image] Generating image: ${url.slice(0, 120)}...`);

  const response = await fetch(url, {
    headers: { "Accept": "image/*" },
    signal: AbortSignal.timeout(120_000), // 2 minute timeout
  });

  if (!response.ok) {
    throw new Error(`Image generation failed: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Detect image generation request in accumulated text
export function detectImageRequest(fullText: string): {
  request: ImageGenerationRequest;
  cleanText: string;
} | null {
  const request = detectImageGenerationRequest(fullText);
  if (!request) return null;
  const cleanText = stripImageGenerationMarker(fullText);
  return { request, cleanText };
}

// Process an image generation request: generate, store, create artifact, emit event
export async function processImageGeneration(
  runId: string,
  projectId: string,
  request: ImageGenerationRequest,
): Promise<Artifact | null> {
  const width = request.width ?? 1024;
  const height = request.height ?? 1024;
  const mimeType = imageMimeType(request.format);

  try {
    // Create pending artifact
    const artifact = await prisma.artifact.create({
      data: {
        projectId,
        runId,
        type: "image",
        mimeType,
        filename: artifactFilename("image", mimeType, request.prompt),
        storageKey: "", // Will be set after generation
        size: 0,
        width,
        height,
        status: "processing",
        prompt: request.prompt,
        metadata: {
          negativePrompt: request.negativePrompt,
          style: request.style,
          ...request.metadata,
        },
      },
    });

    // Emit processing event
    await emitArtifactEvent(runId, artifact, "created");

    // Generate image
    const imageBuffer = await generateWithPollinations(
      request.prompt,
      width,
      height,
    );

    // Store image
    await ensureStorageDir();
    const storageKey = `${artifact.id}.${request.format ?? "png"}`;
    const filePath = path.join(IMAGE_STORAGE_DIR, storageKey);
    await fs.writeFile(filePath, imageBuffer);

    // Update artifact with storage info
    const updated = await prisma.artifact.update({
      where: { id: artifact.id },
      data: {
        storageKey,
        size: imageBuffer.length,
        status: "completed",
      },
    });

    // Emit completed event
    await emitArtifactEvent(runId, updated, "completed");

    console.log(`[aurex-image] Image generated: ${artifact.id} (${imageBuffer.length} bytes)`);

    return artifactToInterface(updated);
  } catch (error) {
    console.error(`[aurex-image] Generation failed:`, error);

    // Try to update artifact status
    try {
      await prisma.artifact.updateMany({
        where: { runId, status: "processing" },
        data: {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {}

    return null;
  }
}

// Emit artifact event via SSE
async function emitArtifactEvent(
  runId: string,
  artifact: { id: string; type: string; mimeType: string; filename: string; storageKey: string; size: number; width: number | null; height: number | null; status: string; prompt: string | null; createdAt: Date },
  action: "created" | "updated" | "completed" | "failed",
): Promise<void> {
  const seq = await nextRunSeq(runId);
  const createdAt = new Date().toISOString();

  const artifactData = {
    id: artifact.id,
    type: artifact.type,
    mimeType: artifact.mimeType,
    filename: artifact.filename,
    storageKey: artifact.storageKey,
    size: artifact.size,
    width: artifact.width,
    height: artifact.height,
    status: artifact.status,
    prompt: artifact.prompt,
  };

  await prisma.agentEvent.create({
    data: {
      runId,
      seq,
      type: "artifact",
      data: { artifact: artifactData, action } as object,
      createdAt: new Date(createdAt),
    },
  });

  await publishRunEvent({
    runId,
    seq,
    type: "artifact",
    data: { artifact: artifactData, action },
    createdAt,
  });
}

// Convert Prisma artifact to interface
function artifactToInterface(a: {
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
  metadata: unknown;
  prompt: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Artifact {
  return {
    id: a.id,
    projectId: a.projectId,
    runId: a.runId,
    messageId: a.messageId,
    type: a.type as Artifact["type"],
    mimeType: a.mimeType,
    filename: a.filename,
    storageKey: a.storageKey,
    size: a.size,
    width: a.width,
    height: a.height,
    status: a.status as Artifact["status"],
    error: a.error,
    metadata: a.metadata as Record<string, unknown>,
    prompt: a.prompt,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

// Get artifact file path
export function getArtifactPath(storageKey: string): string {
  return path.join(IMAGE_STORAGE_DIR, storageKey);
}

// Check if artifact file exists
export async function artifactExists(storageKey: string): Promise<boolean> {
  try {
    await fs.access(getArtifactPath(storageKey));
    return true;
  } catch {
    return false;
  }
}

// Read artifact file
export async function readArtifactFile(storageKey: string): Promise<Buffer> {
  return fs.readFile(getArtifactPath(storageKey));
}
