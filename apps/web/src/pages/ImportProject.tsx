import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type ImportStepView } from "../api";
import { useAuth } from "../auth";
import { C, F, GAP, PAD, Icon, Avatar } from "../components/project-ui";
import { IMPORT_LIMITS } from "@aurex/shared/import";

type Mode = "folder" | "zip";
type Phase = "pick" | "uploading" | "processing" | "ready" | "error" | "cancelled";

interface PickedFile {
  path: string;
  file: File;
}

/** Directories that never make sense to import. */
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "vendor",
  "__pycache__", ".venv", "venv", "target", "coverage", ".cache", ".turbo",
  ".gradle", "Pods", ".idea", ".vscode",
]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Filter a raw file list down to what we are allowed/willing to upload. */
function collectFiles(raw: { path: string; file: File }[]): PickedFile[] {
  return raw
    .map(({ path, file }) => {
      // Drop the first path segment if it is the picked folder/zip name itself.
      const segs = path.split("/").filter(Boolean);
      if (segs.length > 1 && segs[0] === file.name) segs.shift();
      return { path: segs.join("/"), file };
    })
    .filter((e) => {
      const segs = e.path.split("/");
      if (segs.some((s) => EXCLUDED_DIRS.has(s))) return false;
      if (EXCLUDED_FILES.has(segs[segs.length - 1])) return false;
      if (e.file.size > IMPORT_LIMITS.MAX_FILE_BYTES) return false;
      return e.path.length > 0;
    });
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: { path: string; file: File }[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((res) =>
      (entry as FileSystemFileEntry).file(
        (f) => res(f),
        () => res(null),
      ),
    );
    if (file && !EXCLUDED_FILES.has(file.name)) out.push({ path: `${prefix}${entry.name}`, file });
    return;
  }
  if (entry.isDirectory && !EXCLUDED_DIRS.has(entry.name)) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res) =>
        reader.readEntries(
          (es) => res(es),
          () => res([]),
        ),
      );
      if (batch.length === 0) break;
      for (const e of batch) await walkEntry(e, `${prefix}${entry.name}/`, out);
    }
  }
}

export default function ImportProject() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [mode, setMode] = useState<Mode>("folder");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [progress, setProgress] = useState(0);
  const [steps, setSteps] = useState<ImportStepView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<Record<string, unknown> | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);

  const totalBytes = mode === "zip"
    ? (zipFile?.size ?? 0)
    : picked.reduce((a, p) => a + p.file.size, 0);

  // ---- selection -----------------------------------------------------------

  const acceptFolderFiles = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    const raw = Array.from(list).map((f) => ({
      path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      file: f,
    }));
    const files = collectFiles(raw);
    let bytes = 0;
    const oversized = files.filter((f) => f.file.size > IMPORT_LIMITS.MAX_FILE_BYTES);
    const kept = files.filter((f) => !oversized.includes(f));
    for (const f of kept) bytes += f.file.size;
    if (!name.trim()) setName(baseName(raw[0]?.path ?? "") || "");
    setPicked(kept);
    setError(
      oversized.length > 0
        ? `Skipped ${oversized.length} file(s) over the ${fmtBytes(IMPORT_LIMITS.MAX_FILE_BYTES)} per-file limit`
        : null,
    );
  }, [name]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (phase !== "pick") return;
    const items = Array.from(e.dataTransfer.items ?? []);
    if (items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
      const out: { path: string; file: File }[] = [];
      const roots: FileSystemEntry[] = [];
      for (const it of items) {
        const entry = it.webkitGetAsEntry?.();
        if (entry) roots.push(entry);
      }
      for (const r of roots) await walkEntry(r, "", out);
      if (out.length === 0) return;
      const files = collectFiles(out);
      if (mode === "zip") {
        const zf = out.find((o) => o.file.name.toLowerCase().endsWith(".zip"));
        if (zf) { setZipFile(zf.file); if (!name.trim()) setName(zf.file.name.replace(/\.zip$/i, "")); }
        return;
      }
      if (!name.trim() && roots.length === 1 && roots[0].isDirectory) {
        setName(roots[0].name);
      }
      setPicked(files);
      return;
    }
    // Plain file drop fallback
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length === 0) return;
    if (dropped.length === 1 && dropped[0].name.toLowerCase().endsWith(".zip")) {
      setZipFile(dropped[0]);
      if (!name.trim()) setName(dropped[0].name.replace(/\.zip$/i, ""));
      return;
    }
    if (mode === "zip" && dropped.length === 1) {
      setZipFile(dropped[0]);
      if (!name.trim()) setName(dropped[0].name.replace(/\.[^.]+$/, ""));
      return;
    }
    const files = collectFiles(dropped.map((f) => ({ path: f.name, file: f })));
    setPicked(files);
  }, [phase, mode, name]);

  // ---- upload pipeline -----------------------------------------------------

  const startImport = async () => {
    if (phase !== "pick") return;
    setError(null);
    cancelRef.current = false;
    setPhase("uploading");
    setProgress(0);

    try {
      const effectiveMode: Mode = mode === "zip" ? "zip" : "folder";
      if (effectiveMode === "zip" && !zipFile) throw new Error("Choose a .zip archive first");
      if (effectiveMode === "folder" && picked.length === 0) throw new Error("Choose a folder with at least one file");

      const init = await api.importInit(effectiveMode, name.trim() || "Imported Project");
      lastStatusRef.current = init.importId;
      setSteps(init.steps);
      setProjectId(init.projectId);

      if (effectiveMode === "zip" && zipFile) {
        await api.importUploadZip(init.importId, zipFile, (pct) => setProgress(Math.round(pct * 0.6)));
      } else if (effectiveMode === "folder") {
        // Sort for stable batches; upload BATCH-sized groups sequentially.
        const sorted = [...picked].sort((a, b) => a.path.localeCompare(b.path));
        const batchSize = 40;
        let sent = 0;
        const total = sorted.reduce((a, p) => a + p.file.size, 0) || 1;
        for (let i = 0; i < sorted.length; i += batchSize) {
          if (cancelRef.current) break;
          const batch = sorted.slice(i, i + batchSize);
          await api.importUploadBatch(init.importId, batch, (pct) => {
            const batchBytes = batch.reduce((a, p) => a + p.file.size, 0);
            setProgress(Math.round(((sent + (batchBytes * pct) / 100) / total) * 60));
          });
          sent += batch.reduce((a, p) => a + p.file.size, 0);
        }
        if (cancelRef.current) {
          await api.importCancel(init.importId).catch(() => undefined);
          setPhase("cancelled");
          return;
        }
      } else if (effectiveMode === "zip" && zipFile) {
        await api.importUploadZip(init.importId, zipFile, (pct) => setProgress(Math.round(pct * 0.6)));
      }

      // Trigger extraction + detection on the server
      await api.importComplete(init.importId);

      setPhase("processing");
      setProgress(65);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  // Poll while processing; lastStatusRef holds the active import id.
  const lastStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (phase !== "processing" || !lastStatusRef.current) return;
    let stop = false;
    const interval = setInterval(async () => {
      try {
        if (!lastStatusRef.current || stop) return;
        const s = await api.importStatus(lastStatusRef.current);
        if (stop) return;
        setSteps(s.steps ?? []);
        setProgress((p) => Math.max(p, 70));
        if (s.status === "ready") {
          setPhase("ready");
          setDetected(s.detected);
          clearInterval(interval);
        } else if (s.status === "failed" || s.status === "cancelled") {
          setError(s.error ?? `Import ${s.status}`);
          setPhase(s.status === "cancelled" ? "cancelled" : "error");
          clearInterval(interval);
        }
      } catch { /* transient */ }
    }, 1200);
    return () => { stop = true; clearInterval(interval); };
  }, [phase]);

  const doStart = () => void startImport();

  const reset = () => {
    setPhase("pick"); setPicked([]); setZipFile(null); setSteps([]);
    setProgress(0); setError(null); setDetected(null); setProjectId(null);
    lastStatusRef.current = null;
  };

  const userName = user?.name ?? user?.email ?? "User";
  const busy = phase === "uploading" || phase === "processing";

  const stepIcon = (st?: string) =>
    st === "done" ? "check_circle" : st === "active" ? "pending" : st === "error" ? "cancel" : "radio_button_unchecked";
  const stepColor = (st?: string) =>
    st === "done" ? C.primary : st === "active" ? C.secondary : st === "error" ? C.error : C.outline;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: C.background, color: C.onBackground, fontFamily: F.body }}>
      {/* Top bar */}
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: `12px ${PAD}px`, borderBottom: `1px solid ${C.outlineVariant}`, background: C.surfaceContainerLow }}>
        <Link to="/dashboard" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none", color: C.onSurfaceVariant }} title="Back to dashboard">
          <div style={{ width: 26, height: 26, borderRadius: 7, background: C.primary, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: F.display, fontSize: 13, fontWeight: 800, color: "#000" }}>A</span>
          </div>
        </Link>
        <div style={{ fontFamily: F.code, fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant }}>Import Project</div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => void logout().then(() => navigate("/"))} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }} title="Log out">
            <Avatar src={user?.avatarUrl} name={userName} />
          </button>
        </div>
      </header>

      <main className="aurex-scroll" style={{ flex: 1, overflowY: "auto", padding: "32px 24px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: GAP * 3 }}>
          <div>
            <h1 style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, color: C.onSurface, margin: 0 }}>Bring your existing codebase</h1>
            <p style={{ fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant, margin: "6px 0 0" }}>
              Upload a folder or ZIP archive. Aurex copies it into your isolated workspace, detects the stack, and the agent continues working on it like any other app.
            </p>
          </div>

          {/* Mode switch */}
          <div style={{ display: "flex", gap: GAP }}>
            {([
              ["folder", "folder_open", "Folder"],
              ["zip", "archive", "ZIP archive"],
            ] as const).map(([m, icon, label]) => (
              <button key={m} disabled={busy}
                onClick={() => { setMode(m); setPicked([]); setZipFile(null); }}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 16px",
                  borderRadius: 8, fontFamily: F.code, fontSize: 12, fontWeight: 700, cursor: busy ? "default" : "pointer",
                  border: `1px solid ${mode === m ? C.primary : C.outlineVariant}`,
                  background: mode === m ? "rgba(78,222,163,0.08)" : "transparent",
                  color: mode === m ? C.primary : C.onSurfaceVariant,
                }}
              >
                <Icon name={icon} size={16} color="currentColor" />{label}
              </button>
            ))}
          </div>

          {/* Name */}
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontFamily: F.code, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: C.outline }}>Project name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} disabled={busy}
              placeholder="My Imported App"
              style={{
                padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.outlineVariant}`, outline: "none",
                background: C.surfaceContainerLowest, color: C.onSurface, fontFamily: F.body, fontSize: 14,
              }}
            />
          </label>

          {/* Drop zone / picker */}
          {phase === "pick" && (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => void onDrop(e)}
                onClick={() => (mode === "folder" ? folderInputRef.current?.click() : zipInputRef.current?.click())}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "36px 20px", cursor: "pointer",
                  borderRadius: 10, textAlign: "center",
                  border: `1px dashed ${dragOver ? C.primary : C.outlineVariant}`,
                  background: dragOver ? "rgba(78,222,163,0.06)" : C.surfaceContainerLowest,
                  transition: "all 0.15s",
                }}
              >
                <Icon name={mode === "folder" ? "drive_folder_upload" : "upload_file"} size={40} color={C.primary} />
                <div style={{ fontFamily: F.body, fontSize: 14, fontWeight: 600, color: C.onSurface }}>
                  {mode === "folder" ? "Click to choose a folder, or drop it here" : "Click to choose a .zip file, or drop it here"}
                </div>
                <div style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>
                  node_modules, .git and build output are skipped automatically · max {fmtBytes(mode === "zip" ? IMPORT_LIMITS.MAX_ZIP_BYTES : IMPORT_LIMITS.MAX_FOLDER_BYTES)}
                </div>
              </div>

              <input
                ref={(el) => {
                  (folderInputRef as { current: HTMLInputElement | null }).current = el;
                  if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
                }}
                type="file" multiple style={{ display: "none" }}
                onChange={(e) => { acceptFolderFiles(e.target.files); e.target.value = ""; }}
              />
              <input ref={zipInputRef} type="file" accept=".zip,application/zip" style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { setZipFile(f); if (!name.trim()) setName(f.name.replace(/\.zip$/i, "")); }
                  e.target.value = "";
                }}
              />

              {mode === "folder" && picked.length > 0 && (
                <div style={{ background: C.surfaceContainerLowest, border: `1px solid ${C.outlineVariant}`, borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: C.surfaceContainerHigh, fontFamily: F.code, fontSize: 12, fontWeight: 700, color: C.onSurfaceVariant }}>
                    <Icon name="folder_open" size={15} color={C.primary} />
                    {picked.length.toLocaleString()} files · {fmtBytes(totalBytes)}
                  </div>
                  <div className="aurex-scroll" style={{ maxHeight: 200, overflowY: "auto", padding: "8px 16px", display: "flex", flexDirection: "column", gap: 2 }}>
                    {picked.slice(0, 100).map((p) => (
                      <div key={p.path} style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.path}</div>
                    ))}
                    {picked.length > 100 && (
                      <div style={{ fontFamily: F.code, fontSize: 11, color: C.outline, paddingTop: 4 }}>…and {(picked.length - 100).toLocaleString()} more</div>
                    )}
                  </div>
                </div>
              )}
              {mode === "zip" && zipFile && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: C.surfaceContainerLowest, border: `1px solid ${C.outlineVariant}`, borderRadius: 8 }}>
                  <Icon name="archive" size={18} color={C.primary} />
                  <span style={{ fontFamily: F.code, fontSize: 12, color: C.onSurface }}>{zipFile.name}</span>
                  <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>{fmtBytes(zipFile.size)}</span>
                  <button onClick={(e) => { e.stopPropagation(); setZipFile(null); }} disabled={busy}
                    style={{ marginLeft: "auto", background: "transparent", border: "none", color: C.error, cursor: busy ? "default" : "pointer", fontFamily: F.code, fontSize: 11 }}>
                    remove
                  </button>
                </div>
              )}

              <div style={{ display: "flex", gap: GAP, justifyContent: "flex-end" }}>
                {error && <span style={{ fontFamily: F.code, fontSize: 12, color: C.error, alignSelf: "center", marginRight: "auto" }}>{error}</span>}
                <button onClick={doStart}
                  disabled={(mode === "folder" ? picked.length === 0 : !zipFile)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "10px 24px", borderRadius: 8,
                    border: `1px solid ${C.primary}`, background: C.primary, color: "#000",
                    fontFamily: F.code, fontSize: 12, fontWeight: 700, cursor: "pointer",
                    opacity: (mode === "folder" ? picked.length === 0 : !zipFile) ? 0.5 : 1,
                  }}
                >
                  <Icon name="cloud_upload" size={16} color="#000" /> Import project
                </button>
              </div>
            </>
          )}

          {/* Progress */}
          {(busy || phase === "ready" || phase === "error" || phase === "cancelled") && steps.length > 0 && (
            <div style={{ background: C.surfaceContainerLowest, border: `1px solid ${C.outlineVariant}`, borderRadius: 8, padding: PAD }}>
              <div style={{ height: 6, borderRadius: 999, background: C.surfaceContainerHigh, overflow: "hidden", marginBottom: 16 }}>
                <div style={{
                  width: `${Math.min(progress, phase === "ready" ? 100 : progress)}%`,
                  height: "100%",
                  background: phase === "error" || phase === "cancelled" ? C.error : C.primary,
                  transition: "width 0.4s ease",
                }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {steps.map((s) => (
                  <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Icon name={stepIcon(s.status)} size={18} color={stepColor(s.status)} fill={s.status === "active"} />
                    <span style={{ fontFamily: F.code, fontSize: 12, color: s.status === "pending" ? C.outline : C.onSurface }}>{s.label}</span>
                    {s.status === "active" && <span className="spinner" />}
                  </div>
                ))}
              </div>
              {(phase === "uploading" || phase === "processing") && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
                  <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>{progress}%</span>
                  <button
                    onClick={async () => {
                      cancelRef.current = true;
                      if (lastStatusRef.current) await api.importCancel(lastStatusRef.current).catch(() => undefined);
                    }}
                    style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${C.error}`, color: C.error, borderRadius: 6, padding: "4px 12px", fontFamily: F.code, fontSize: 11, cursor: "pointer" }}
                  >
                    Cancel import
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Error / cancelled */}
          {(phase === "error" || phase === "cancelled") && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 8, background: "rgba(255,180,171,0.08)", border: `1px solid ${C.error}` }}>
              <Icon name="error" size={18} color={C.error} />
              <span style={{ fontFamily: F.code, fontSize: 12, color: C.error }}>{error}</span>
              <button onClick={reset} style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${C.outlineVariant}`, color: C.onSurface, borderRadius: 6, padding: "4px 12px", fontFamily: F.code, fontSize: 11, cursor: "pointer" }}>
                Start over
              </button>
            </div>
          )}

          {/* Ready */}
          {phase === "ready" && (
            <div style={{ display: "flex", flexDirection: "column", gap: GAP * 2, padding: PAD, borderRadius: 8, background: "rgba(78,222,163,0.05)", border: `1px solid ${C.primary}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Icon name="check_circle" size={22} color={C.primary} fill />
                <span style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, color: C.onSurface }}>Project imported</span>
              </div>
              {detected && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: GAP }}>
                  {([
                    ["Language", detected.language],
                    ["Framework", detected.framework],
                    ["Runtime", detected.runtime],
                    ["Package manager", detected.packageManager],
                  ] as [string, string | undefined][]).map(([k, v]) =>
                    v ? (
                      <div key={k} style={{ padding: "8px 12px", background: C.surfaceContainerLowest, borderRadius: 6, border: `1px solid ${C.outlineVariant}` }}>
                        <div style={{ fontFamily: F.code, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: C.outline }}>{k}</div>
                        <div style={{ fontFamily: F.code, fontSize: 12, color: C.onSurface, marginTop: 2 }}>{v}</div>
                      </div>
                    ) : null,
                  )
                  }
                </div>
              )}
              <div style={{ display: "flex", gap: GAP, justifyContent: "flex-end" }}>
                <button onClick={reset} style={{ background: "transparent", border: `1px solid ${C.outlineVariant}`, color: C.onSurface, borderRadius: 8, padding: "8px 16px", fontFamily: F.code, fontSize: 12, cursor: "pointer" }}>
                  Import another
                </button>
                {projectId && (
                  <button onClick={() => navigate(`/projects/${projectId}`)}
                    style={{ display: "flex", alignItems: "center", gap: 8, background: C.primary, border: `1px solid ${C.primary}`, color: "#000", borderRadius: 8, padding: "8px 20px", fontFamily: F.code, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    Open project <Icon name="arrow_forward" size={15} color="#000" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
