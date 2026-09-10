import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { C, F, Icon, ProjectShell, TopBar } from "../components/project-ui";

/* ------------------------------------------------------------------ */
/*  Create file / folder modal                                        */
/* ------------------------------------------------------------------ */
function CreateModal({
  kind,
  parentPath,
  onConfirm,
  onCancel,
}: {
  kind: "file" | "folder";
  parentPath: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const placeholder = kind === "file" ? "example.ts" : "new-folder";
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.surfaceContainerHigh, borderRadius: 16,
          border: `1px solid ${C.outlineVariant}`, padding: 28,
          width: 420, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 36, height: 36, borderRadius: 10,
              background: `${C.primary}18`, display: "flex",
              alignItems: "center", justifyContent: "center",
            }}
          >
            <Icon name={kind === "file" ? "note_add" : "create_new_folder"} size={20} color={C.primary} />
          </div>
          <span style={{ fontFamily: F.display, fontSize: 17, fontWeight: 700, color: C.onSurface }}>
            New {kind === "file" ? "File" : "Folder"}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, letterSpacing: "0.04em" }}>
            Name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
            style={{
              padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.outlineVariant}`,
              background: C.surfaceContainerLowest, color: C.onSurface,
              fontFamily: F.code, fontSize: 13, outline: "none",
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onConfirm(name.trim()); if (e.key === "Escape") onCancel(); }}
          />
          {parentPath && (
            <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>
              in {parentPath || "/"}
            </span>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "7px 16px", borderRadius: 8, border: `1px solid ${C.outlineVariant}`,
              background: "transparent", color: C.onSurface, fontFamily: F.body, fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => name.trim() && onConfirm(name.trim())}
            disabled={!name.trim()}
            style={{
              padding: "7px 16px", borderRadius: 8, border: "none",
              background: name.trim() ? C.primary : C.surfaceContainerHighest,
              color: name.trim() ? "#000" : C.onSurfaceVariant,
              fontFamily: F.body, fontSize: 13, fontWeight: 700,
              cursor: name.trim() ? "pointer" : "default", opacity: name.trim() ? 1 : 0.5,
              transition: "all 0.15s",
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Rename modal                                                      */
/* ------------------------------------------------------------------ */
function RenameModal({
  path,
  onConfirm,
  onCancel,
}: {
  path: string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}) {
  const parts = path.split("/");
  const oldName = parts.pop() ?? path;
  const dir = parts.join("/");
  const [name, setName] = useState(oldName);
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.surfaceContainerHigh, borderRadius: 16,
          border: `1px solid ${C.outlineVariant}`, padding: 28,
          width: 420, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 36, height: 36, borderRadius: 10,
              background: `${C.primary}18`, display: "flex",
              alignItems: "center", justifyContent: "center",
            }}
          >
            <Icon name="drive_file_rename_outline" size={20} color={C.primary} />
          </div>
          <span style={{ fontFamily: F.display, fontSize: 17, fontWeight: 700, color: C.onSurface }}>
            Rename
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, letterSpacing: "0.04em" }}>
            New name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.outlineVariant}`,
              background: C.surfaceContainerLowest, color: C.onSurface,
              fontFamily: F.code, fontSize: 13, outline: "none",
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && name !== oldName) onConfirm(name.trim()); if (e.key === "Escape") onCancel(); }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "7px 16px", borderRadius: 8, border: `1px solid ${C.outlineVariant}`,
              background: "transparent", color: C.onSurface, fontFamily: F.body, fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => name.trim() && name !== oldName && onConfirm(name.trim())}
            disabled={!name.trim() || name === oldName}
            style={{
              padding: "7px 16px", borderRadius: 8, border: "none",
              background: name.trim() && name !== oldName ? C.primary : C.surfaceContainerHighest,
              color: name.trim() && name !== oldName ? "#000" : C.onSurfaceVariant,
              fontFamily: F.body, fontSize: 13, fontWeight: 700,
              cursor: name.trim() && name !== oldName ? "pointer" : "default",
              opacity: name.trim() && name !== oldName ? 1 : 0.5, transition: "all 0.15s",
            }}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Delete confirmation modal                                         */
/* ------------------------------------------------------------------ */
function DeleteConfirmModal({
  path,
  onConfirm,
  onCancel,
}: {
  path: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const fileName = path.split("/").pop() ?? path;
  const [typed, setTyped] = useState("");
  const match = typed === fileName;
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.surfaceContainerHigh, borderRadius: 16,
          border: `1px solid ${C.outlineVariant}`, padding: 28,
          width: 420, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 36, height: 36, borderRadius: 10,
              background: `${C.error}18`, display: "flex",
              alignItems: "center", justifyContent: "center",
            }}
          >
            <Icon name="delete_forever" size={20} color={C.error} />
          </div>
          <span style={{ fontFamily: F.display, fontSize: 17, fontWeight: 700, color: C.onSurface }}>
            Delete {fileName}?
          </span>
        </div>
        <p style={{ fontFamily: F.body, fontSize: 13, color: C.onSurfaceVariant, margin: 0, lineHeight: 1.5 }}>
          This will permanently delete <b style={{ color: C.onSurface }}>{fileName}</b> from your workspace.
          {path.includes("/") && (
            <> This action applies to the file <b style={{ fontFamily: F.code, fontSize: 12 }}>{path}</b>.</>
          )}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, letterSpacing: "0.04em" }}>
            Type <b style={{ color: C.error }}>{fileName}</b> to confirm
          </label>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={fileName}
            style={{
              padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.outlineVariant}`,
              background: C.surfaceContainerLowest, color: C.onSurface,
              fontFamily: F.code, fontSize: 13, outline: "none",
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && match) onConfirm(); if (e.key === "Escape") onCancel(); }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "7px 16px", borderRadius: 8, border: `1px solid ${C.outlineVariant}`,
              background: "transparent", color: C.onSurface, fontFamily: F.body, fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!match}
            style={{
              padding: "7px 16px", borderRadius: 8, border: "none",
              background: match ? C.error : C.surfaceContainerHighest,
              color: match ? "#fff" : C.onSurfaceVariant,
              fontFamily: F.body, fontSize: 13, fontWeight: 700,
              cursor: match ? "pointer" : "default", opacity: match ? 1 : 0.5,
              transition: "all 0.15s",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  };
  return (
    <button
      onClick={() => void copy()}
      title={copied ? "Copied!" : (label ?? "Copy to clipboard")}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 6,
        border: "none",
        background: copied ? `${C.primary}20` : "transparent",
        color: copied ? C.primary : C.onSurfaceVariant,
        cursor: "pointer",
        flexShrink: 0,
        transition: "all 0.15s",
      }}
      onMouseEnter={(e) => { if (!copied) e.currentTarget.style.background = C.surfaceContainerHigh; }}
      onMouseLeave={(e) => { if (!copied) e.currentTarget.style.background = "transparent"; }}
    >
      <Icon name={copied ? "check" : "content_copy"} size={16} color="currentColor" />
    </button>
  );
}

interface TNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TNode[];
}

function buildTree(files: string[]): TNode[] {
  const root: TNode[] = [];
  const map = new Map<string, TNode>();
  for (const f of files) {
    const clean = f.replace(/^\.\//, "").replace(/\/$/, "");
    if (!clean) continue;
    const parts = clean.split("/");
    let cur = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      acc = acc ? `${acc}/${part}` : part;
      const isLast = i === parts.length - 1;
      let node = map.get(acc);
      if (!node) {
        node = { name: part, path: acc, type: isLast ? "file" : "dir", children: isLast ? undefined : [] };
        map.set(acc, node);
        cur.push(node);
      }
      if (!isLast) cur = node.children ?? [];
    }
  }
  return root;
}

function initialExpanded(nodes: TNode[]): Set<string> {
  const s = new Set<string>();
  const visit = (ns: TNode[], depth: number) => {
    for (const n of ns) {
      if (n.type === "dir") {
        if (depth < 1) s.add(n.path);
        visit(n.children ?? [], depth + 1);
      }
    }
  };
  visit(nodes, 0);
  return s;
}

export default function FileManager() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [projectName, setProjectName] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<{ content?: string; binary?: boolean; truncated?: boolean; size?: number } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createModal, setCreateModal] = useState<{ kind: "file" | "folder"; parentPath: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [p, f] = await Promise.all([
        api.getProject(projectId).then((x) => x.name).catch(() => ""),
        api.listFiles(projectId),
      ]);
      setProjectName(p);
      setFiles(f.files);
      setContainerId(f.containerId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tree = useMemo(() => buildTree(files), [files]);
  useEffect(() => {
    setExpanded(initialExpanded(tree));
  }, [tree]);

  const open = async (path: string) => {
    if (!projectId) return;
    setSelected(path);
    setContent(null);
    setFileLoading(true);
    setFileError(null);
    setEditing(false);
    setSaveMsg(null);
    try {
      const r = await api.readFile(projectId, path);
      if (!r.ok) {
        setFileError(r.error ?? "Failed to read file.");
      } else {
        setContent(r);
        setEditContent(r.content ?? "");
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setFileLoading(false);
    }
  };

  const saveFile = async () => {
    if (!projectId || !selected) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.writeFile(projectId, selected, editContent);
      setContent((prev) => prev ? { ...prev, content: editContent } : prev);
      setEditing(false);
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const deleteFile = async () => {
    if (!projectId || !deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteFile(projectId, deleteTarget);
      // If the deleted file was selected, clear selection.
      if (selected === deleteTarget) {
        setSelected(null);
        setContent(null);
      }
      setDeleteTarget(null);
      // Refresh the file list.
      await load();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const createItem = async (name: string) => {
    if (!projectId || !createModal) return;
    const parentDir = createModal.parentPath;
    const isFile = createModal.kind === "file";
    const fullPath = parentDir ? `${parentDir}/${name}` : name;
    try {
      if (isFile) {
        // Create an empty file by writing nothing to it.
        await api.writeFile(projectId, fullPath, "");
      } else {
        await api.createFolder(projectId, fullPath);
      }
      setCreateModal(null);
      await load();
      // If a file was created, open it for editing.
      if (isFile) {
        const path = fullPath.startsWith("./") ? fullPath : `./${fullPath}`;
        await open(path);
        setEditing(true);
        setEditContent("");
      }
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Create failed");
    }
  };

  const renameItem = async (newName: string) => {
    if (!projectId || !renameTarget) return;
    const parts = renameTarget.split("/");
    const oldName = parts.pop() ?? "";
    if (newName === oldName) { setRenameTarget(null); return; }
    parts.push(newName);
    const newPath = parts.join("/");
    try {
      await api.renameFile(projectId, renameTarget, newPath);
      // Update selection if the renamed item was selected.
      if (selected === renameTarget) {
        const norm = newPath.startsWith("./") ? newPath : `./${newPath}`;
        setSelected(norm);
      }
      setRenameTarget(null);
      await load();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Rename failed");
    }
  };

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectedName = selected?.split("/").pop() ?? "";

  const renderNode = (node: TNode, depth: number) => {
    const isDir = node.type === "dir";
    const isOpen = expanded.has(node.path);
    const isSel = selected === node.path;
    return (
      <div key={node.path} style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            onClick={() => (isDir ? toggle(node.path) : void open(node.path))}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: 1,
              minWidth: 0,
              padding: "5px 8px",
              paddingLeft: 8 + depth * 14,
              border: "none",
              borderRadius: 6,
              background: isSel ? `${C.primary}1a` : "transparent",
              color: isSel ? C.primary : isDir ? C.onSurfaceVariant : C.onSurface,
              fontFamily: F.code,
              fontSize: 12,
              textAlign: "left",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => {
              if (!isSel) e.currentTarget.style.background = C.surfaceContainerHigh;
            }}
            onMouseLeave={(e) => {
              if (!isSel) e.currentTarget.style.background = "transparent";
            }}
          >
            {isDir ? (
              <Icon name={isOpen ? "folder_open" : "folder"} size={15} color={isOpen ? C.primary : C.onSurfaceVariant} />
            ) : (
              <Icon name="description" size={15} color={C.onSurfaceVariant} />
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
          </button>
          {!isDir && (
            <>
              <button
                className="file-action-btn"
                onClick={(e) => { e.stopPropagation(); setRenameTarget(node.path); }}
                title="Rename"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, borderRadius: 4, border: "none",
                  background: "transparent", color: C.onSurfaceVariant,
                  cursor: "pointer", flexShrink: 0, opacity: 0,
                  transition: "all 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = `${C.primary}15`; e.currentTarget.style.color = C.primary; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.onSurfaceVariant; }}
              >
                <Icon name="edit" size={12} color="currentColor" />
              </button>
              <button
                className="file-action-btn"
                onClick={(e) => { e.stopPropagation(); setDeleteTarget(node.path); }}
                title="Delete"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, borderRadius: 4, border: "none",
                  background: "transparent", color: C.onSurfaceVariant,
                  cursor: "pointer", flexShrink: 0, opacity: 0,
                  transition: "all 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = `${C.error}15`; e.currentTarget.style.color = C.error; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.onSurfaceVariant; }}
              >
                <Icon name="close" size={13} color="currentColor" />
              </button>
            </>
          )}
        </div>
        {isDir && isOpen && (node.children ?? []).map((n) => renderNode(n, depth + 1))}
      </div>
    );
  };

  const userName = user?.name ?? user?.email ?? "User";

  return (
    <ProjectShell
      projectId={projectId ?? ""}
      active="files"
      chatHref={`/projects/${projectId}`}
      onLogout={() => void logout().then(() => navigate("/"))}
      topBar={
        <TopBar projectName={projectName || "—"} status="files" connected={false} avatarUrl={user?.avatarUrl} userName={userName} onLogout={() => void logout().then(() => navigate("/"))} />
      }
    >
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* File tree */}
        <aside
          className="aurex-scroll"
          style={{
            width: 288,
            flexShrink: 0,
            overflowY: "auto",
            borderRight: `1px solid ${C.outlineVariant}`,
            background: C.surfaceContainerLowest,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "10px 14px",
              borderBottom: `1px solid ${C.outlineVariant}`,
            }}
          >
            <span style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant, flex: 1 }}>
              Files
            </span>
            <button
              onClick={() => setCreateModal({ kind: "file", parentPath: "" })}
              title="New file"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 26, borderRadius: 5, border: "none",
                background: "transparent", color: C.onSurfaceVariant, cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.surfaceContainerHigh)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Icon name="note_add" size={15} color="currentColor" />
            </button>
            <button
              onClick={() => setCreateModal({ kind: "folder", parentPath: "" })}
              title="New folder"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 26, borderRadius: 5, border: "none",
                background: "transparent", color: C.onSurfaceVariant, cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.surfaceContainerHigh)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Icon name="create_new_folder" size={15} color="currentColor" />
            </button>
            <button
              onClick={() => void load()}
              title="Refresh files"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 26, borderRadius: 5, border: "none",
                background: "transparent", color: C.onSurfaceVariant, cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.surfaceContainerHigh)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <Icon name="refresh" size={15} color="currentColor" />
            </button>
            {projectId && (
              <a
                href={api.exportCodeUrl(projectId)}
                title="Export as Zip"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 26, height: 26, borderRadius: 5, border: "none",
                  background: "transparent", color: C.primary, cursor: "pointer", textDecoration: "none",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.surfaceContainerHigh)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <Icon name="download" size={15} color="currentColor" />
              </a>
            )}
          </div>

          {loading ? (
            <div style={{ padding: 16, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>Loading files…</div>
          ) : error ? (
            <div style={{ padding: 16, fontFamily: F.code, fontSize: 12, color: C.error }}>{error}</div>
          ) : files.length === 0 ? (
            <div style={{ padding: 16, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
              {containerId ? "Workspace is empty." : "Start a run to create the workspace, then refresh."}
            </div>
          ) : (
            <div style={{ padding: 8, flex: 1 }}>{tree.map((n) => renderNode(n, 0))}</div>
          )}
        </aside>

        {/* File viewer */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!selected ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: C.onSurfaceVariant }}>
              <Icon name="code" size={44} color={C.outlineVariant} />
              <span style={{ fontFamily: F.code, fontSize: 13 }}>Select a file to view its contents</span>
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 16px",
                  borderBottom: `1px solid ${C.outlineVariant}`,
                  background: C.surfaceContainerLow,
                  fontFamily: F.code,
                  fontSize: 12,
                  color: C.onSurfaceVariant,
                }}
              >
                <Icon name="folder" size={14} color={C.onSurfaceVariant} />
                <span style={{ color: C.onSurface }}>{selected}</span>
                {content?.size != null && !content.binary && (
                  <span style={{ marginLeft: "auto", fontSize: 11 }}>{content.size.toLocaleString()} bytes{content.truncated ? " · truncated" : ""}</span>
                )}
                {content?.content && !content.binary && !editing && (
                  <>
                    <button
                      onClick={() => { setEditing(true); setEditContent(content?.content ?? ""); }}
                      title="Edit file"
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 28, height: 28, borderRadius: 6, border: "none",
                        background: "transparent", color: C.onSurfaceVariant, cursor: "pointer", flexShrink: 0, transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceContainerHigh; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <Icon name="edit" size={16} color="currentColor" />
                    </button>
                    <CopyButton text={content.content} label="Copy file contents" />
                    <button
                      onClick={() => setDeleteTarget(selected)}
                      title="Delete file"
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 28, height: 28, borderRadius: 6, border: "none",
                        background: "transparent", color: C.onSurfaceVariant, cursor: "pointer", flexShrink: 0, transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = `${C.error}15`; e.currentTarget.style.color = C.error; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.onSurfaceVariant; }}
                    >
                      <Icon name="delete" size={16} color="currentColor" />
                    </button>
                  </>
                )}
                {saveMsg && (
                  <span style={{ fontSize: 11, color: saveMsg === "Saved" ? C.primary : C.error }}>{saveMsg}</span>
                )}
              </div>
              <div className="aurex-scroll" style={{ flex: 1, overflow: "auto", background: C.surfaceContainerLowest, display: "flex", flexDirection: "column" }}>
                {fileLoading ? (
                  <div style={{ padding: 24, display: "flex", alignItems: "center", gap: 12, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
                    <span
                      style={{
                        width: 14, height: 14, borderRadius: 999,
                        border: `2px solid ${C.outlineVariant}`, borderTopColor: C.primary,
                        animation: "aurex-spin 0.8s linear infinite",
                      }}
                    />
                    Reading {selectedName}…
                  </div>
                ) : fileError ? (
                  <div style={{ padding: 24, fontFamily: F.code, fontSize: 12, color: C.error }}>{fileError}</div>
                ) : content?.binary ? (
                  <div style={{ padding: 24, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
                    Binary file — not shown in the editor.
                  </div>
                ) : editing ? (
                  <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      style={{
                        flex: 1, margin: 0, padding: 20, border: "none", outline: "none", resize: "none",
                        fontFamily: F.code, fontSize: 13, lineHeight: 1.7,
                        color: C.onSurface, background: C.surfaceContainerLowest,
                      }}
                      spellCheck={false}
                    />
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: `1px solid ${C.outlineVariant}`, background: C.surfaceContainerLow }}>
                      <button
                        onClick={() => void saveFile()}
                        disabled={saving}
                        style={{
                          display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 6,
                          background: C.primary, color: "#000", border: "none", fontFamily: F.code, fontSize: 12, fontWeight: 700,
                          cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1, transition: "opacity 0.15s",
                        }}
                      >
                        <Icon name="save" size={14} color="#000" />
                        {saving ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={() => { setEditing(false); setEditContent(content?.content ?? ""); }}
                        disabled={saving}
                        style={{
                          display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 6,
                          background: "transparent", color: C.onSurface, border: `1px solid ${C.outlineVariant}`,
                          fontFamily: F.code, fontSize: 12, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1,
                        }}
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                ) : (
                  <pre
                    style={{
                      margin: 0, padding: 20,
                      fontFamily: F.code, fontSize: 13, lineHeight: 1.7,
                      color: C.onSurface, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}
                  >
                    {content?.content}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {deleteTarget && (
        <DeleteConfirmModal
          path={deleteTarget}
          onConfirm={() => void deleteFile()}
          onCancel={() => { setDeleteTarget(null); setDeleting(false); }}
        />
      )}
      {createModal && (
        <CreateModal
          kind={createModal.kind}
          parentPath={createModal.parentPath}
          onConfirm={(name) => void createItem(name)}
          onCancel={() => setCreateModal(null)}
        />
      )}
      {renameTarget && (
        <RenameModal
          path={renameTarget}
          onConfirm={(name) => void renameItem(name)}
          onCancel={() => setRenameTarget(null)}
        />
      )}
      <style>{`.file-action-btn { opacity: 0 !important; } div:hover > .file-action-btn, .file-action-btn:focus { opacity: 1 !important; }`}</style>
    </ProjectShell>
  );
}
