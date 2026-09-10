/**
 * Import Project: turn an uploaded codebase (folder or ZIP) into a persistent
 * Aurex workspace.
 *
 * Flow (all state persisted in ProjectImport so the UI polls real progress):
 *   POST /init      -> validate limits, create Project + ProjectImport rows,
 *                      ensure the personal workspace container is running.
 *   POST /:id/batch -> folder mode: receive files in batches, sanitize every
 *                      relative path server-side, stage them under a host tmp
 *                      dir, track real received bytes/count.
 *   POST /:id/zip   -> zip mode: stream one archive to a host tmp file.
 *   POST /:id/complete -> transfer staged data INTO the isolated workspace
 *                      container (tar pipe for folders; python3 zipfile
 *                      extraction for archives, with traversal/symlink/bomb
 *                      protection), audit the extracted tree, detect the
 *                      technology stack, mark the import ready.
 *   GET  /:id       -> status + steps + detection result for polling.
 *
 * Failures clean up after themselves: host staging dir, freshly created
 * container directory and both DB rows (project cascades) are removed.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { prisma } from "@aurex/db";
import {
  containerState,
  ensureWorkspaceDir,
  execCapture,
  listFilesInWorkspace,
  pipeIntoExec,
  startWorkspace,
  workspaceContainerName,
} from "@aurex/docker";
import {
  IMPORT_LIMITS,
  IMPORT_LIMITS as LIMITS,
  initialImportSteps,
  sanitizeImportPath,
  detectProject,
  workspaceRunDirectory,
  WORKSPACE_ROOT,
  type DetectedProject,
  type ImportStep,
  type ImportStepKey,
} from "@aurex/shared";
import { canAccess } from "../access.js";
import { ensurePersonalWorkspace } from "../auth.js";

const BATCH_MAX_FILES = 40;
const STALE_IMPORT_MS = 2 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["receiving", "extracting", "detecting", "analyzing"];

const router = Router();

// ---------------------------------------------------------------------------
// helpers

function friendly(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Multer aborts oversized uploads with its own error class — translate it. */
function multerGuard(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch((e) => {
      const code = (e as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: `upload exceeds the ${Math.round(LIMITS.MAX_FILE_BYTES / 1024 / 1024)} MB per-file limit` });
        return;
      }
      if (code === "LIMIT_FILE_COUNT") {
        res.status(413).json({ error: `too many files in one batch (max ${BATCH_MAX_FILES})` });
        return;
      }
      next(e);
    });
  };
}

interface StepRow {
  key: ImportStepKey;
  label: string;
  status: ImportStep["status"];
  at?: string;
}

async function patchStep(
  importId: string,
  key: ImportStepKey,
  status: StepRow["status"],
  extra?: { status?: string; error?: string; detected?: DetectedProject; fileCount?: number; totalBytes?: number },
): Promise<void> {
  const imp = await prisma.projectImport.findUnique({ where: { id: importId } });
  if (!imp) throw new HttpError(404, "import session expired");
  const steps = ((imp.steps as StepRow[] | null) ?? initialImportSteps()).map((s) =>
    s.key === key ? { ...s, status, at: new Date().toISOString() } : s,
  );
  await prisma.projectImport.update({
    where: { id: importId },
    data: {
      // JSON round-trip so the typed step rows satisfy Prisma's Json input.
      steps: JSON.parse(JSON.stringify(steps)),
      updatedAt: new Date(),
      ...(extra?.status !== undefined ? { status: extra.status } : {}),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
      ...(extra?.detected !== undefined ? { detected: extra.detected as unknown as object } : {}),
      ...(extra?.fileCount !== undefined ? { fileCount: extra.fileCount } : {}),
      ...(extra?.totalBytes !== undefined ? { totalBytes: extra.totalBytes } : {}),
    },
  });
}

interface OwnedImport {
  id: string;
  projectId: string;
  mode: string;
  status: string;
  stagingDir: string | null;
  fileCount: number;
  totalBytes: number;
  projectOwnerId: string | null;
  projectName: string;
}

async function getOwnedImport(req: Request, res: Response): Promise<OwnedImport | null> {
  const imp = await prisma.projectImport.findUnique({
    where: { id: req.params.id },
    include: { project: { select: { ownerId: true, name: true } } },
  });
  if (!imp) {
    res.status(404).json({ error: "import not found" });
    return null;
  }
  if (!canAccess(imp.project.ownerId, req.user?.id)) {
    res.status(403).json({ error: "you do not have access to this import" });
    return null;
  }
  return {
    id: imp.id,
    projectId: imp.projectId,
    mode: imp.mode,
    status: imp.status,
    stagingDir: imp.stagingDir,
    fileCount: imp.fileCount,
    totalBytes: imp.totalBytes,
    projectOwnerId: imp.project.ownerId,
    projectName: imp.project.name,
  };
}

/** Same as getOwnedImport but throws instead of responding; narrows null away. */
async function requireActive(req: Request, res: Response): Promise<OwnedImport> {
  const imp = await getOwnedImport(req, res);
  if (!imp) throw new HttpError(404, "import not found");
  if (!ACTIVE_STATUSES.includes(imp.status)) {
    throw new HttpError(409, `import is already ${imp.status}`);
  }
  return imp;
}

/** Resolve the user's personal workspace and make sure its container is up. */
async function ensureRunningWorkspace(userId: string): Promise<{ workspaceId: string; containerName: string }> {
  const ws = await ensurePersonalWorkspace(userId);
  const containerName = workspaceContainerName(ws.id);
  const state = await containerState(containerName);
  if (state === "missing" || state === "stopped") {
    const { workspaceQueue, WORKSPACE_JOB } = await import("../queue.js");
    await workspaceQueue
      .add(WORKSPACE_JOB.Ensure, { workspaceId: ws.id, resourceLimits: ws.resourceLimits }, { removeOnComplete: 100, removeOnFail: 100 })
      .catch(() => undefined);
    for (let i = 0; i < 60; i++) {
      if ((await containerState(containerName)) === "running") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if ((await containerState(containerName)) !== "running") {
      throw new HttpError(503, "workspace container did not become ready in time; please retry");
    }
  }
  return { workspaceId: ws.id, containerName };
}

/** Remove everything an import created: host staging, container dir, DB rows. */
async function cleanupFailedImport(imp: {
  id: string;
  projectId: string;
  stagingDir: string | null;
  containerName: string;
  directory: string;
}): Promise<void> {
  if (imp.stagingDir) await rm(imp.stagingDir, { recursive: true, force: true }).catch(() => undefined);
  // Best-effort removal of anything already extracted into the container.
  await execCapture(imp.containerName, ["sh", "-c", 'rm -rf -- "$1"', "sh", imp.directory]).catch(() => undefined);
  await prisma.agentRun.deleteMany({ where: { projectId: imp.projectId } }).catch(() => undefined);
  await prisma.project.delete({ where: { id: imp.projectId } }).catch(() => undefined);
  await prisma.projectImport.deleteMany({ where: { id: imp.id } }).catch(() => undefined);
}

/**
 * The project folder is derived from the project name everywhere in Aurex, so
 * instead of allowing collisions with an existing project's files we uniquify
 * the NAME ("Evently" -> "Evently 2") until the derived folder is free.
 */
async function uniquifyProjectName(containerName: string, baseName: string): Promise<string> {
  let candidate = baseName.trim() || "Imported Project";
  for (let i = 0; i < 50; i++) {
    const dir = workspaceRunDirectory(WORKSPACE_ROOT, true, candidate);
    const exists = await execCapture(
      containerName,
      ["sh", "-c", '[ -e "$1" ] && echo yes || echo no', "sh", dir],
    ).then((o) => o.trim() === "yes").catch(() => false);
    if (!exists) return candidate;
    candidate = `${baseName} ${i + 2}`;
  }
  throw new HttpError(409, "could not find a free project folder name");
}

// ---------------------------------------------------------------------------
// stale import sweeper (runs lazily on /init)

async function sweepStaleImports(): Promise<void> {
  const stale = await prisma.projectImport.findMany({
    where: { status: { in: ACTIVE_STATUSES }, updatedAt: { lt: new Date(Date.now() - STALE_IMPORT_MS) } },
    include: { project: { select: { id: true, name: true, ownerId: true } } },
    take: 10,
  });
  for (const imp of stale) {
    const ws = await prisma.workspace.findFirst({ where: { ownerId: imp.project.ownerId ?? "__none__" } });
    if (ws) {
      const containerName = workspaceContainerName(ws.id);
      if ((await containerState(containerName)) === "running") {
        const directory = workspaceRunDirectory(ws.path ?? WORKSPACE_ROOT, true, imp.project.name);
        await execCapture(containerName, ["sh", "-c", 'rm -rf -- "$1"', "sh", directory]).catch(() => undefined);
      }
    }
    if (imp.stagingDir) await rm(imp.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await prisma.project.delete({ where: { id: imp.projectId } }).catch(() => undefined);
    await prisma.projectImport.deleteMany({ where: { id: imp.id } }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------

router.post(
  "/init",
  multerGuard(async (req, res, next) => {
    try {
      void sweepStaleImports().catch(() => undefined);

      const mode = req.body?.mode === "folder" ? "folder" : "zip";
      const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const name = (rawName || "Imported Project").slice(0, 60);

      if (req.user?.id) {
        const busy = await prisma.projectImport.findFirst({
          where: { status: { in: ACTIVE_STATUSES }, project: { ownerId: req.user.id } },
          select: { id: true },
        });
        if (busy) throw new HttpError(409, "another import is already in progress");
      }

      const { workspaceId, containerName } = await ensureRunningWorkspace(req.user?.id ?? "");

      const project = await prisma.project.create({
        data: {
          name,
          description: mode === "folder" ? "Imported from local folder" : "Imported from ZIP archive",
          ownerId: req.user?.id ?? null,
        },
      });

      const stagingDir = await mkdtemp(join(tmpdir(), "aurex-import-"));
      await mkdir(join(stagingDir, "files"), { recursive: true });

      const steps = initialImportSteps();
      const idx = steps.findIndex((s) => s.key === "workspace");
      if (idx >= 0) steps[idx] = { ...steps[idx], status: "done", at: new Date().toISOString() };

      const imp = await prisma.projectImport.create({
        data: {
          projectId: project.id,
          mode,
          status: "receiving",
          // JSON round-trip so the typed step rows satisfy Prisma's Json input.
          steps: JSON.parse(JSON.stringify(steps)),
          stagingDir,
        },
      });

      res.status(201).json({
        importId: imp.id,
        projectId: project.id,
        workspaceId,
        steps,
      });
      void containerName;
    } catch (e) {
      next(e);
    }
  }),
);

// --- folder mode: batched uploads ------------------------------------------

const batchUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      cb(null, `aurex-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    },
  }),
  limits: { files: BATCH_MAX_FILES + 1, fileSize: LIMITS.MAX_FILE_BYTES, fieldSize: 1024 * 1024 },
});

interface ManifestEntry {
  i: number;
  path: string;
}

router.post(
  "/:id/batch",
  batchUpload.any(),
  multerGuard(async (req, res, next) => {
    try {
      const imp = await requireActive(req, res);
      if (imp.mode !== "folder") throw new HttpError(400, "this import session is not a folder upload");

      let manifest: ManifestEntry[];
      try {
        manifest = JSON.parse(String(req.body?.meta ?? "[]")) as ManifestEntry[];
      } catch {
        throw new HttpError(400, "invalid upload manifest");
      }
      if (!Array.isArray(manifest) || manifest.length === 0) throw new HttpError(400, "upload manifest is required");
      if (manifest.length > BATCH_MAX_FILES) throw new HttpError(400, `too many files in one batch (max ${BATCH_MAX_FILES})`);

      const files = (req.files as Express.Multer.File[]) ?? [];
      const byField = new Map<string, Express.Multer.File>();
      for (const f of files) byField.set(f.fieldname, f);

      const stagingFiles = join(imp.stagingDir!, "files");
      let receivedFiles = imp.fileCount;
      let receivedBytes = imp.totalBytes;

      for (const entry of manifest) {
        const file = byField.get(`f${entry.i}`);
        if (!file) throw new HttpError(400, `missing file part f${entry.i}`);
        const safePath = sanitizeImportPath(entry.path ?? "");
        if (!safePath) throw new HttpError(400, `unsafe file path rejected: ${String(entry.path).slice(0, 80)}`);
        if (file.size > LIMITS.MAX_FILE_BYTES) throw new HttpError(413, `"${safePath}" exceeds the ${LIMITS.MAX_FILE_BYTES / 1024 / 1024} MB per-file limit`);
        receivedFiles += 1;
        receivedBytes += file.size;
        if (receivedFiles > LIMITS.MAX_FILES) throw new HttpError(413, `too many files (limit ${IMPORT_LIMITS.MAX_FILES}). Exclude node_modules/build output and retry.`);
        if (receivedBytes > LIMITS.MAX_FOLDER_BYTES) throw new HttpError(413, `project too large (limit ${LIMITS.MAX_FOLDER_BYTES / 1024 / 1024} MB)`);

        const target = join(stagingFiles, safePath);
        if (!target.startsWith(stagingFiles + "/")) throw new HttpError(400, "unsafe file path rejected");
        await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true }).catch(() => undefined);
        // stream from disk to avoid double-buffering large files
        const { copyFile, unlink } = await import("node:fs/promises");
        const srcPath = (file as unknown as { path?: string }).path;
        if (srcPath) {
          await copyFile(srcPath, target);
          await unlink(srcPath).catch(() => {});
        } else if ((file as unknown as { buffer?: Buffer }).buffer) {
          await writeFile(target, (file as unknown as { buffer: Buffer }).buffer);
        } else {
          throw new HttpError(500, "upload storage error");
        }
      }

      // Real cumulative upload progress persisted after every batch.
      await patchStep(imp.id, "workspace", "done", {
        fileCount: receivedFiles,
        totalBytes: receivedBytes,
      });

      res.json({ ok: true, receivedFiles, receivedBytes });
    } catch (e) {
      next(e);
    }
  }),
);

// --- zip mode ---------------------------------------------------------------

const zipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = join(tmpdir(), `aurex-import-zip-${String(req.params.id ?? "unknown").replace(/[^\w-]/g, "")}`);
      mkdir(dir, { recursive: true })
        .then(() => cb(null, dir))
        .catch((e) => cb(e, ""));
    },
    filename: (_req, _file, cb) => cb(null, "upload.zip"),
  }),
  limits: { files: 1, fileSize: LIMITS.MAX_ZIP_BYTES },
});

router.post(
  "/:id/zip",
  zipUpload.single("file"),
  multerGuard(async (req, res, next) => {
    try {
      const imp = await requireActive(req, res);
      if (imp.mode !== "zip") throw new HttpError(400, "this import session expects individual files, not a zip");
      const file = req.file;
      if (!file) throw new HttpError(400, "a zip file is required (multipart field 'file')");
      if (file.size === 0) throw new HttpError(400, "uploaded archive is empty");

      // Magic-byte check before trusting the archive at all.
      const head = Buffer.alloc(4);
      const fd = await import("node:fs/promises").then((m) => m.open(file.path, "r"));
      try {
        await fd.read(head, 0, 4, 0);
      } finally {
        await fd.close();
      }
      const magic = head.toString("latin1");
      if (magic !== "PK\u0003\u0004" && magic !== "PK\u0005\u0006" && magic !== "PK\u0007\u0008") {
        await rm(file.path, { force: true }).catch(() => undefined);
        throw new HttpError(400, "that file is not a valid ZIP archive");
      }

      await patchStep(imp.id, "workspace", "done", { totalBytes: file.size });
      await prisma.projectImport.update({
        where: { id: imp.id },
        data: { totalBytes: file.size, stagingDir: file.path },
      });
      res.json({ ok: true, receivedBytes: file.size });
    } catch (e) {
      next(e);
    }
  }),
);

// --- completion: transfer, audit, detect ------------------------------------

/** Python extractor executed INSIDE the workspace container (authoritative). */
const EXTRACTOR_SCRIPT = String.raw`
import json, os, stat, sys, zipfile

def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(2)

spec = json.loads(sys.argv[1])
dest = os.path.realpath(spec["dest"])
max_files = int(spec["max_files"]); max_total = int(spec["max_bytes"]); max_file = int(spec["max_file_bytes"])

try:
    zf = zipfile.ZipFile(spec["zip"])
    infos = zf.infolist()
except Exception:
    fail("not a valid zip archive")

entries = []
for i in infos:
    name = i.filename
    if i.is_dir():
        continue
    mode = (i.external_attr >> 16) & 0xFFFF
    ftype = stat.S_IFMT(mode)
    if ftype == stat.S_IFLNK:
        fail("symlinks are not allowed in imported archives")
    if ftype not in (0, stat.S_IFREG):
        fail("unsupported entry type: %s" % name[:120])
    norm = name.replace("\\", "/")
    if norm.startswith("/"):
        fail("absolute path in archive: %s" % name[:120])
    parts = [p for p in norm.split("/") if p not in ("", ".")]
    if not parts:
        continue
    if any(p == ".." for p in parts):
        fail("path traversal detected: %s" % name[:120])
    if any(len(seg) > 255 for seg in parts):
        fail("path segment too long: %s" % name[:120])
    if len(norm) > 512:
        fail("path too long: %s" % name[:120])
    if i.flag_bits & 0x1:
        fail("encrypted archives are not supported")
    entries.append((i, "/".join(parts)))

if len(entries) > max_files:
    fail("archive contains %d files (limit %d)" % (len(entries), max_files))

total = sum(i.file_size for i, _ in entries)
if total > max_total:
    fail("archive expands beyond the size limit")

roots = set(p.split("/", 1)[0] for _, p in entries)
strip_root = None
if len(roots) == 1 and entries and all("/" in p for _, p in entries):
    strip_root = next(iter(roots))

count = 0
written = 0
os.makedirs(dest, exist_ok=True)
try:
    for info, p in entries:
        rel = p[len(strip_root) + 1:] if strip_root else p
        out = os.path.realpath(os.path.join(dest, rel))
        if out != dest and not out.startswith(dest + os.sep):
            fail("extraction escaped the destination")
        parent = os.path.dirname(out)
        if parent.startswith(dest) and parent != dest:
            os.makedirs(parent, exist_ok=True)
        elif parent != dest:
            fail("extraction escaped the destination")
        with zf.open(info) as src, open(out, "wb") as fh:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_total:
                    fail("archive exceeds the size limit during extraction")
                fh.write(chunk)
        count += 1
except zipfile.BadZipFile:
    fail("corrupted zip archive")
except RuntimeError:
    fail("encrypted archives are not supported")
except OSError as e:
    fail("extraction failed: %s" % str(e)[:160])

print(json.dumps({"ok": True, "files": count, "bytes": written, "stripped_root": strip_root}))
`;

async function writeExtractorScript(containerName: string, importId: string): Promise<string> {
  const path = `/tmp/.aurex-extract-${importId}.py`;
  const b64 = Buffer.from(EXTRACTOR_SCRIPT, "utf8").toString("base64");
  await execCapture(
    containerName,
    ["sh", "-c", 'printf %s "$1" | base64 -d > "$2"', "sh", b64, path],
    15_000,
  );
  return path;
}

/** Post-extraction audit inside the container: counts, sizes, evil entries. */
async function auditExtractedTree(containerName: string, directory: string): Promise<{ files: number; bytes: number }> {
  const countOut = await execCapture(
    containerName,
    ["sh", "-c", 'find "$1" -type f | wc -l', "sh", directory],
    30_000,
  ).catch(() => "0");
  const files = parseInt(countOut.trim() || "0", 10);
  if (files > LIMITS.MAX_FILES) {
    throw new HttpError(413, `extracted project has ${files} files (limit ${LIMITS.MAX_FILES})`);
  }

  const duOut = await execCapture(
    containerName,
    ["sh", "-c", 'du -sb "$1" 2>/dev/null | cut -f1', "sh", directory],
    30_000,
  ).catch(() => "0");
  const bytes = parseInt(duOut.trim() || "0", 10);
  if (bytes > LIMITS.MAX_EXTRACTED_BYTES) {
    throw new HttpError(413, `extracted project is ${Math.round(bytes / 1024 / 1024)} MB (limit ${LIMITS.MAX_EXTRACTED_BYTES / 1024 / 1024} MB)`);
  }

  // Any surviving traversal artifact means something slipped past the
  // extractor — refuse loudly rather than keep a compromised workspace.
  const evil = await execCapture(
    containerName,
    ["sh", "-c", 'find "$1" -name ".." -o -name "..*" -type l 2>/dev/null | head -5', "sh", directory],
    30_000,
  ).catch(() => "");
  if (evil.trim()) throw new HttpError(400, "unsafe entries were found after extraction; import refused");

  return { files, bytes };
}

/** Read a small manifest file from inside the container (null when missing). */
async function readManifestFile(containerName: string, directory: string, rel: string): Promise<string | null> {
  try {
    const out = await execCapture(
      containerName,
      ["sh", "-c", 'head -c 65536 "$1" 2>/dev/null', "sh", join(directory, rel)],
      10_000,
    );
    return out ?? null;
  } catch {
    return null;
  }
}

function normalizeListing(files: string[]): string[] {
  return files.map((f) => (f.startsWith("./") ? f.slice(2) : f)).filter(Boolean);
}

async function detectStack(
  containerName: string,
  directory: string,
): Promise<DetectedProject> {
  const rawListing = await listFilesInWorkspace(containerName, directory).catch(() => [] as string[]);
  const files = normalizeListing(rawListing);
  return detectProject(files, (manifest) => readManifestFile(containerName, directory, manifest));
}

router.post(
  "/:id/complete",
  multerGuard(async (req, res, next) => {
    try {
      const imp = await requireActive(req, res);

      // Validate that the source payload actually exists before touching the
      // workspace (a directory where a zip should be, or an empty staging dir,
      // would otherwise blow up mid-stream).
      const st = await stat(imp.stagingDir ?? "").catch(() => null);
      if (imp.mode === "zip") {
        if (!st || !st.isFile()) throw new HttpError(400, "no ZIP has been uploaded yet");
      } else {
        if (!st || !st.isDirectory()) throw new HttpError(400, "no files have been uploaded yet");
      }

      const { containerName } = await ensureRunningWorkspace(imp.projectOwnerId ?? "");
      const projectName = await uniquifyProjectName(containerName, imp.projectName);
      await prisma.project.update({ where: { id: imp.projectId }, data: { name: projectName } });
      const directory = workspaceRunDirectory(WORKSPACE_ROOT, true, projectName);

      await patchStep(imp.id, "upload", "done", { status: "extracting" });
      await ensureWorkspaceDir(containerName, directory);

      if (imp.mode === "folder") {
        const stagedDir = join(imp.stagingDir!, "files");
        const hasFiles = await readdir(stagedDir).then((xs) => xs.length > 0).catch(() => false);
        if (!hasFiles) throw new HttpError(400, "no files were uploaded for this import");
        const tarProc = spawn("tar", ["-C", stagedDir, "--exclude=node_modules", "-cf", "-", "."], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let tarErr = "";
        tarProc.stderr.on("data", (c: Buffer) => {
          tarErr += c.toString();
        });
        const tarDone = new Promise<void>((resolve, reject) => {
          tarProc.on("error", reject);
          tarProc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(tarErr.trim() || `tar exited with code ${code}`))));
        });
        await Promise.all([
          tarDone,
          pipeIntoExec(containerName, ["tar", "-xf", "-", "-C", directory], tarProc.stdout as Readable, 10 * 60_000),
        ]);
      } else {
        // zip: push archive into the container, extract with python3 there.
        const containerZip = `/tmp/.aurex-import-${imp.id}.zip`;
        const zipStream = createReadStream(imp.stagingDir!);
        await pipeIntoExec(
          containerName,
          ["sh", "-c", 'cat > "$1"', "sh", containerZip],
          zipStream as Readable,
          10 * 60_000,
        );

        const extractorPath = await writeExtractorScript(containerName, imp.id);
        const spec = JSON.stringify({
          zip: containerZip,
          dest: directory,
          max_files: LIMITS.MAX_FILES,
          max_bytes: LIMITS.MAX_EXTRACTED_BYTES,
          max_file_bytes: LIMITS.MAX_FILE_BYTES,
        });
        const out = await execCapture(
          containerName,
          ["python3", extractorPath, spec],
          10 * 60_000,
        ).catch((e) => {
          throw new HttpError(400, friendly(e).split("\n")[0]?.slice(0, 240) || "extraction failed");
        });

        let result: { ok: boolean; error?: string; files?: number };
        try {
          result = JSON.parse(out.trim().split("\n").pop() ?? "{}") as typeof result;
        } catch {
          throw new HttpError(500, "unexpected extractor output");
        }
        if (!result.ok) throw new HttpError(400, result.error ?? "extraction failed");
        await execCapture(containerName, ["sh", "-c", 'rm -f -- "$1" "$2"', "sh", containerZip, extractorPath]).catch(() => undefined);
      }

      await patchStep(imp.id, "extract", "done", { status: "detecting" });

      const audit = await auditExtractedTree(containerName, directory);
      if (audit.files === 0) throw new HttpError(400, "nothing could be imported — the source was empty");

      await patchStep(imp.id, "detect", "active", { status: "analyzing" });
      const detected = await detectStack(containerName, directory);

      await patchStep(imp.id, "detect", "done");
      await patchStep(imp.id, "analyze", "done");
      await patchStep(imp.id, "ready", "done", {
        status: "ready",
        detected,
        fileCount: audit.files,
        totalBytes: Math.max(audit.bytes, 0),
      });

      if (imp.stagingDir) await rm(imp.stagingDir, { recursive: true, force: true }).catch(() => undefined);

      res.json({
        ok: true,
        projectId: imp.projectId,
        projectName,
        detected,
        fileCount: audit.files,
      });
    } catch (e) {
      // Full cleanup on any failure: staging dir, container dir, project rows.
      const impId = req.params.id;
      const fresh = await prisma.projectImport.findUnique({ where: { id: impId } }).catch(() => null);
      if (fresh) {
        const proj = await prisma.project.findUnique({ where: { id: fresh.projectId }, select: { ownerId: true, name: true } });
        const ws = proj?.ownerId ? await prisma.workspace.findUnique({ where: { ownerId: proj.ownerId } }) : null;
        await cleanupFailedImport({
          id: fresh.id,
          projectId: fresh.projectId,
          stagingDir: fresh.stagingDir,
          containerName: ws ? workspaceContainerName(ws.id) : "",
          directory: ws ? workspaceRunDirectory(ws.path ?? WORKSPACE_ROOT, true, proj?.name ?? "") : "",
        }).catch(() => undefined);
      }
      if (e instanceof HttpError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      next(e);
    }
  }),
);

// --- polling -----------------------------------------------------------------

router.get("/:id", async (req, res, next) => {
  try {
    const imp = await getOwnedImport(req, res);
    if (!imp) return;
    const row = await prisma.projectImport.findUnique({
      where: { id: imp.id },
      include: { project: { select: { id: true, name: true } } },
    });
    if (!row) {
      res.status(404).json({ error: "import not found" });
      return;
    }
    res.json({
      id: row.id,
      projectId: row.project.id,
      projectName: row.project.name,
      mode: row.mode,
      status: row.status,
      error: row.error,
      steps: row.steps ?? initialImportSteps(),
      detected: row.detected ?? null,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch (e) {
    next(e);
  }
});

// Explicit cancel: same cleanup as a failure.
router.post("/:id/cancel", async (req, res, next) => {
  try {
    const imp = await getOwnedImport(req, res);
    if (!imp) return;
    if (!ACTIVE_STATUSES.includes(imp.status)) {
      res.json({ ok: true, status: imp.status });
      return;
    }
    const ws = await prisma.workspace.findUnique({ where: { ownerId: imp.projectOwnerId ?? "" } });
    await cleanupFailedImport({
      id: imp.id,
      projectId: imp.projectId,
      stagingDir: imp.stagingDir,
      containerName: ws ? workspaceContainerName(ws.id) : "",
      directory: ws ? workspaceRunDirectory(ws.path ?? WORKSPACE_ROOT, true, imp.projectName) : "",
    });
    res.json({ ok: true, status: "cancelled" });
  } catch (e) {
    next(e);
  }
});

export default router;
