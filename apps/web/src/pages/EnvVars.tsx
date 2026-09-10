import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { C, F, Icon, ProjectShell, TopBar } from "../components/project-ui";

export default function EnvVars() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [projectName, setProjectName] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    api
      .getProject(projectId)
      .then((p) => setProjectName(p.name))
      .catch(() => undefined);
    api
      .getProjectEnv(projectId)
      .then((r) => {
        setContent(r.content);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [projectId]);

  const importFromWorkspace = async () => {
    if (!projectId || importing) return;
    setImporting(true);
    try {
      const r = await api.getProjectEnv(projectId);
      setContent(r.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const count = useMemo(() => {
    const m = content.match(/^[A-Za-z_][A-Za-z0-9_]*\s*=/gm);
    return m ? m.length : 0;
  }, [content]);

  const save = async () => {
    if (!projectId || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.saveProjectEnv(projectId, content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const userName = user?.name ?? user?.email ?? "User";

  return (
    <ProjectShell
      projectId={projectId ?? ""}
      active="env"
      chatHref={`/projects/${projectId}`}
      onLogout={() => void logout().then(() => navigate("/"))}
      topBar={
        <TopBar projectName={projectName || "—"} status="env" connected={false} avatarUrl={user?.avatarUrl} userName={userName} onLogout={() => void logout().then(() => navigate("/"))} />
      }
    >
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }} className="aurex-scroll">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 8 }}>
            <div>
              <h1 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, color: C.onSurface, margin: 0 }}>
                Environment Variables
              </h1>
              <p style={{ fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant, margin: "4px 0 0" }}>
                Stored in <span style={{ color: C.primary }}>.env</span> in the project workspace and injected into every run.
              </p>
            </div>
            <span
              style={{
                fontFamily: F.code,
                fontSize: 11,
                color: C.onSurfaceVariant,
                background: C.surfaceContainerHigh,
                border: `1px solid ${C.outlineVariant}`,
                padding: "4px 10px",
                borderRadius: 999,
                whiteSpace: "nowrap",
              }}
            >
              {count} {count === 1 ? "variable" : "variables"}
            </span>
          </div>

          <div
            style={{
              marginTop: 20,
              background: C.surfaceContainerLowest,
              border: `1px solid ${C.outlineVariant}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 16px",
                background: C.surfaceContainerHigh,
                borderBottom: `1px solid ${C.outlineVariant}`,
                fontFamily: F.code,
                fontSize: 12,
                fontWeight: 700,
                color: C.onSurfaceVariant,
              }}
            >
              <Icon name="key" size={16} color={C.primary} />
              .env
              {error && <span style={{ color: C.error, fontWeight: 400 }}>— {error}</span>}
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              placeholder={"# Add your project's credentials here\n# DATABASE_URL=postgres://user:pass@host/db\n# API_TOKEN=your-secret-key"}
              style={{
                width: "100%",
                minHeight: 320,
                padding: 16,
                background: "transparent",
                border: "none",
                color: C.onSurface,
                fontFamily: F.code,
                fontSize: 13,
                lineHeight: 1.6,
                resize: "vertical",
                outline: "none",
              }}
              className="aurex-scroll"
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
            <button
              onClick={() => void save()}
              disabled={saving}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 20px", borderRadius: 8,
                border: `1px solid ${C.primary}`, background: C.primary, color: "#000",
                fontFamily: F.code, fontSize: 12, fontWeight: 700,
                cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1,
              }}
            >
              <Icon name="save" size={16} color="#000" />
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => void importFromWorkspace()}
              disabled={importing}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 8,
                border: `1px solid ${C.outlineVariant}`, background: "transparent", color: C.onSurface,
                fontFamily: F.code, fontSize: 12,
                cursor: importing ? "default" : "pointer", opacity: importing ? 0.6 : 1,
              }}
            >
              <Icon name="download" size={14} color="currentColor" />
              {importing ? "Importing…" : "Import from .env"}
            </button>
            {saved && <span style={{ fontFamily: F.code, fontSize: 12, color: C.primary }}>✓ saved to workspace</span>}
            <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, marginLeft: "auto" }}>
              KEY=VALUE per line — comments with #
            </span>
          </div>
      </div>
    </ProjectShell>
  );
}
