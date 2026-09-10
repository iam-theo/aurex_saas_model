/**
 * Screenshot storage helpers (Phase 6).
 *
 * Screenshots are written to the configured output directory (the Aurex
 * workspace/artifact area) as PNG files. When no output directory is
 * configured they stay in-memory only (returned as base64 via the caller).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";

export function writeScreenshot(
  outputDir: string,
  buffer: Buffer,
  sessionId: string,
  timestamp: string,
): Promise<string> {
  const stamp = timestamp.replace(/[:.]/g, "-");
  const filename = `${sessionId}-${stamp}.png`;
  const dir = isAbsolute(outputDir) ? outputDir : resolve(outputDir);
  return (async () => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, filename);
    await writeFile(path, buffer);
    return path;
  })();
}
