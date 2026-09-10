/**
 * Shared primitives for the Import Project feature: server-enforced limits and
 * path-safety helpers used by both the upload staging path (API, host side) and
 * the post-extraction audit. Pure functions so they are unit-testable without
 * docker or a database.
 */

export const IMPORT_LIMITS = {
  /** Hard cap on the uploaded zip archive size. */
  MAX_ZIP_BYTES: 200 * 1024 * 1024,
  /** Hard cap on the cumulative size of an uploaded folder. */
  MAX_FOLDER_BYTES: 400 * 1024 * 1024,
  /** Hard cap on uncompressed content extracted from an archive. */
  MAX_EXTRACTED_BYTES: 800 * 1024 * 1024,
  /** Maximum number of files in one import. */
  MAX_FILES: 4000,
  /** Maximum size of any single file inside an import. */
  MAX_FILE_BYTES: 25 * 1024 * 1024,
  /** Maximum length of one relative path segment chain (characters). */
  MAX_PATH_LENGTH: 256,
  /** Maximum directory depth of one relative path. */
  MAX_PATH_DEPTH: 16,
} as const;

export type ImportMode = "folder" | "zip";

export type ImportStatus =
  | "receiving"
  | "extracting"
  | "detecting"
  | "analyzing"
  | "ready"
  | "failed";

export type ImportStepKey =
  | "workspace"
  | "upload"
  | "extract"
  | "detect"
  | "analyze"
  | "ready";

export interface ImportStep {
  key: ImportStepKey;
  label: string;
  status: "pending" | "active" | "done" | "failed";
  at?: string;
}

/** Ordered checklist rendered by the import UI. Server-maintained only. */
export function initialImportSteps(): ImportStep[] {
  return [
    { key: "workspace", label: "Workspace created", status: "pending" },
    { key: "upload", label: "Upload received", status: "pending" },
    { key: "extract", label: "Project extracted", status: "pending" },
    { key: "detect", label: "Detecting technology", status: "pending" },
    { key: "analyze", label: "Analyzing project", status: "pending" },
    { key: "ready", label: "Project ready", status: "pending" },
  ];
}

/**
 * Sanitize an uploaded relative path. Returns null when the path is unsafe
 * (traversal, absolute, Windows drive, control characters, too long/deep).
 * Backslashes are normalized to forward slashes first.
 */
export function sanitizeImportPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > IMPORT_LIMITS.MAX_PATH_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts.length > IMPORT_LIMITS.MAX_PATH_DEPTH) return null;
  for (const part of parts) {
    if (part === "." || part === "..") return null;
    // Windows drive / device names ("C:", "\\server", "NUL") never make sense
    // inside the Linux workspace.
    if (/^[a-zA-Z]:$/.test(part)) return null;
    if (part === "." || /^\.+$/.test(part)) return null;
  }
  return parts.join("/");
}

/**
 * Detect a single common root folder across all paths (e.g. every entry of a
 * zip that wrapped everything in "my-project/"). Returns the stripped paths,
 * or the original array when there is no single common root.
 */
export function stripCommonRoot(paths: string[]): { paths: string[]; root: string | null } {
  if (paths.length === 0) return { paths, root: null };
  const firstSegments = new Set<string>();
  for (const p of paths) {
    const i = p.indexOf("/");
    firstSegments.add(i === -1 ? "" : p.slice(0, i));
  }
  if (firstSegments.size !== 1) return { paths, root: null };
  const root = [...firstSegments][0];
  if (!root) return { paths, root: null };
  // Only strip when EVERY path actually lives inside the root folder; loose
  // top-level files ("" first segment) prevent stripping.
  const allNested = paths.every((p) => p.includes("/"));
  if (!allNested) return { paths, root: null };
  return { paths: paths.map((p) => p.slice(root.length + 1)), root };
}

/** Aggregate guard used while receiving uploads. Throws with a friendly message. */
export class ImportLimitError extends Error {}

export function assertWithinLimits(input: {
  fileCount: number;
  totalBytes: number;
}): void {
  const { fileCount, totalBytes } = input;
  if (fileCount > IMPORT_LIMITS.MAX_FILES) {
    throw new ImportLimitError(
      `Project has too many files (${fileCount}). The limit is ${IMPORT_LIMITS.MAX_FILES}. Remove build artifacts like node_modules and try again.`,
    );
  }
  if (totalBytes > IMPORT_LIMITS.MAX_FOLDER_BYTES) {
    throw new ImportLimitError(
      `Project is too large (${Math.round(totalBytes / 1024 / 1024)} MB). The limit is ${IMPORT_LIMITS.MAX_FOLDER_BYTES / 1024 / 1024} MB.`,
    );
  }
}
