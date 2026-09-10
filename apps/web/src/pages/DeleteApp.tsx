import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Project } from "../api";
import { useAuth } from "../auth";
import { C, F, Icon, ProjectShell, TopBar } from "../components/project-ui";

export default function DeleteApp() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (!projectId) return;
    api
      .getProject(projectId)
      .then((p) => {
        setProject(p);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [projectId]);

  const handleDelete = async () => {
    if (!projectId || deleting) return;
    setDeleting(true);
    setConfirmOpen(false);
    try {
      await api.deleteProject(projectId);
      navigate("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  const userName = user?.name ?? user?.email ?? "User";

  if (loading) {
    return (
      <ProjectShell
        projectId={projectId ?? ""}
        active="delete"
        chatHref={`/projects/${projectId}`}
        onLogout={() => void logout().then(() => navigate("/"))}
        topBar={
          <TopBar projectName="—" status="delete" connected={false} avatarUrl={user?.avatarUrl} userName={userName} onLogout={() => void logout().then(() => navigate("/"))} />
        }
      >
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: C.background }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: F.code, fontSize: 13, color: C.onSurfaceVariant }}>
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 999,
                border: `2px solid ${C.outlineVariant}`,
                borderTopColor: C.primary,
                animation: "aurex-spin 0.8s linear infinite",
              }}
            />
            Loading project…
          </div>
        </div>
      </ProjectShell>
    );
  }

  return (
    <ProjectShell
      projectId={projectId ?? ""}
      active="delete"
      chatHref={`/projects/${projectId}`}
      onLogout={() => void logout().then(() => navigate("/"))}
      topBar={
        <TopBar projectName={project?.name ?? "—"} status="delete" connected={false} avatarUrl={user?.avatarUrl} userName={userName} onLogout={() => void logout().then(() => navigate("/"))} />
      }
    >
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
        className="aurex-scroll"
      >
        <div style={{ width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: `${C.error}20`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="delete" size={28} color={C.error} />
            </div>
            <div>
              <h1 style={{ fontFamily: F.display, fontSize: 22, fontWeight: 800, color: C.onSurface, margin: 0 }}>
                Delete App
              </h1>
              <p style={{ fontFamily: F.body, fontSize: 13, color: C.onSurfaceVariant, margin: "4px 0 0" }}>
                Permanently remove <span style={{ color: C.error, fontWeight: 600 }}>{project?.name}</span> and all of its data.
              </p>
            </div>
          </div>

          {error && (
            <div
              style={{
                marginBottom: 16,
                padding: "10px 14px",
                borderRadius: 8,
                background: `${C.error}14`,
                border: `1px solid ${C.error}40`,
                fontFamily: F.code,
                fontSize: 12,
                color: C.error,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              background: C.surfaceContainerLowest,
              border: `1px solid ${C.outlineVariant}`,
              borderRadius: 12,
              padding: 24,
              marginBottom: 32,
            }}
          >
            <h2 style={{ fontFamily: F.display, fontSize: 14, fontWeight: 700, color: C.onSurface, margin: "0 0 16px" }}>
              What will be deleted
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, fontFamily: F.body, fontSize: 13, color: C.onSurfaceVariant, lineHeight: 1.6 }}>
              <div style={{ display: "flex", gap: 10 }}>
                <Icon name="workspace_preference" size={18} color={C.error} />
                <span>
                  <strong style={{ color: C.onSurface }}>Workspace container</strong> — the running Docker workspace and all files generated during runs.
                </span>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Icon name="storage" size={18} color={C.error} />
                <span>
                  <strong style={{ color: C.onSurface }}>Workspace volume</strong> — persisted project files and attachments.
                </span>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Icon name="play_arrow" size={18} color={C.error} />
                <span>
                  <strong style={{ color: C.onSurface }}>Run history</strong> — all agent runs, logs, events, and artifacts.
                </span>
              </div>
              {project?.publishedUrl && (
                <div style={{ display: "flex", gap: 10 }}>
                  <Icon name="public" size={18} color={C.error} />
                  <span>
                    <strong style={{ color: C.onSurface }}>Published site</strong> — the live deployment at {project.publishedUrl}.
                  </span>
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <Icon name="delete" size={18} color={C.error} />
                <span>
                  <strong style={{ color: C.onSurface }}>Project record</strong> — the project itself in your dashboard.
                </span>
              </div>
            </div>
          </div>

          <div
            style={{
              background: `${C.error}10`,
              border: `1px solid ${C.error}30`,
              borderRadius: 12,
              padding: 20,
              marginBottom: 24,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <Icon name="warning" size={20} color={C.error} />
              <span style={{ fontFamily: F.code, fontSize: 12, fontWeight: 700, color: C.error, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Warning
              </span>
            </div>
            <p style={{ fontFamily: F.body, fontSize: 13, color: C.onSurfaceVariant, margin: 0, lineHeight: 1.6 }}>
              This action is <strong style={{ color: C.error }}>permanent and cannot be undone</strong>. Once you delete this app, there is no way to recover the workspace container, file system, run history, or published site. If you only want to remove the published site, consider unpublishing instead.
            </p>
          </div>

          <button
            onClick={() => setConfirmOpen(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: C.error,
              color: C.onErrorContainer,
              fontFamily: F.code,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "0.85";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
          >
            <Icon name="delete" size={16} color="currentColor" />
            Delete this app
          </button>
        </div>
      </div>

      {confirmOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 200,
          }}
          onClick={() => setConfirmOpen(false)}
        >
          <div
            style={{
              background: C.surfaceContainerLowest,
              border: `1px solid ${C.error}40`,
              borderRadius: 16,
              padding: 28,
              width: "100%",
              maxWidth: 520,
              margin: "16px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: `${C.error}20`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Icon name="warning" size={22} color={C.error} />
              </div>
              <h2 style={{ fontFamily: F.display, fontSize: 18, fontWeight: 700, color: C.onSurface, margin: 0 }}>
                Confirm deletion
              </h2>
            </div>

            <p style={{ fontFamily: F.body, fontSize: 13, color: C.onSurfaceVariant, margin: "0 0 16px", lineHeight: 1.6 }}>
              Type <strong style={{ color: C.error }}>{project?.name ?? ""}</strong> below to confirm you want to permanently delete this app and all of its data.
            </p>

            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={project?.name ?? ""}
              spellCheck={false}
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: 10,
                border: `1px solid ${C.error}50`,
                background: C.surfaceContainerLow,
                color: C.onSurface,
                fontFamily: F.code,
                fontSize: 14,
                marginBottom: 20,
                outline: "none",
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setConfirmOpen(false);
              }}
            />

            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={() => setConfirmOpen(false)}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "10px 20px",
                  borderRadius: 8,
                  border: `1px solid ${C.outlineVariant}`,
                  background: "transparent",
                  color: C.onSurface,
                  fontFamily: F.code,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDelete()}
                disabled={confirmText !== (project?.name ?? "") || deleting}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "10px 20px",
                  borderRadius: 8,
                  border: "none",
                  background: confirmText === project?.name && !deleting ? C.error : C.surfaceContainerHigh,
                  color: confirmText === project?.name && !deleting ? C.onErrorContainer : C.outline,
                  fontFamily: F.code,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  opacity: confirmText === project?.name && !deleting ? 1 : 0.5,
                }}
              >
                <Icon name="delete" size={16} color="currentColor" />
                {deleting ? "Deleting…" : "Delete app"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ProjectShell>
  );
}
