import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { C, F, Icon, ProjectShell, TopBar } from "../components/project-ui";

interface GitInfo {
  remote: string;
  branch: string;
  dirty: number;
  files: string[];
  ahead: number | null;
  behind: number | null;
}

export default function Github() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [projectName, setProjectName] = useState("");
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    api
      .getProject(projectId)
      .then((p) => setProjectName(p.name))
      .catch(() => undefined);
    api
      .getProjectGit(projectId)
      .then((r) => {
        setInfo(r);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [projectId, refreshKey]);

  const userName = user?.name ?? user?.email ?? "User";

  const stat = (label: string, value: string | number | null, icon: string, accent?: string) => (
    <div
      style={{
        flex: 1,
        minWidth: 160,
        background: C.surfaceContainerLow,
        border: `1px solid ${C.outlineVariant}`,
        borderRadius: 8,
        padding: "12px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Icon name={icon} size={16} color={accent ?? C.primary} />
        <span style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant }}>
          {label}
        </span>
      </div>
      <div style={{ fontFamily: F.code, fontSize: 14, fontWeight: 700, color: C.onSurface, wordBreak: "break-all" }}>
        {value || "—"}
      </div>
    </div>
  );

  return (
    <ProjectShell
      projectId={projectId ?? ""}
      active="github"
      chatHref={`/projects/${projectId}`}
      onLogout={() => void logout().then(() => navigate("/"))}
      topBar={
        <TopBar projectName={projectName || "—"} status="github" connected={false} avatarUrl={user?.avatarUrl} userName={userName} onLogout={() => void logout().then(() => navigate("/"))} />
      }
    >
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }} className="aurex-scroll">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
            <div>
              <h1 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, color: C.onSurface, margin: 0 }}>
                Github
              </h1>
              <p style={{ fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant, margin: "4px 0 0" }}>
                Repository status for this project's workspace.
              </p>
            </div>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${C.outlineVariant}`,
                background: C.surfaceContainerHigh,
                color: C.onSurface,
                fontFamily: F.code,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <Icon name="refresh" size={15} color="currentColor" />
              Refresh
            </button>
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

          {loading ? (
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
              Reading repository…
            </div>
          ) : (
            info && (
              <>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
                  {stat("Remote", info.remote, "hub", C.secondary)}
                  {stat("Branch", info.branch, "fork_right")}
                  {stat("Uncommitted", info.dirty, "edit_note", C.tertiary)}
                  {stat("Ahead", info.ahead, "north_east", C.primary)}
                  {stat("Behind", info.behind, "south_west", C.primary)}
                </div>

                {info.remote && (
                  <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
                    <a
                      href={info.remote.startsWith("git@") ? `https://github.com/${info.remote.replace(/^git@github.com:/, "").replace(/\.git$/, "")}` : info.remote.replace(/\.git$/, "")}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 16px",
                        borderRadius: 8,
                        border: `1px solid ${C.primary}`,
                        color: C.primary,
                        fontFamily: F.code,
                        fontSize: 12,
                        fontWeight: 700,
                        textDecoration: "none",
                      }}
                    >
                      <Icon name="open_in_new" size={15} color="currentColor" />
                      Open Repository
                    </a>
                  </div>
                )}

                <div
                  style={{
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
                    <Icon name="description" size={16} color={C.primary} />
                    Working tree{info.dirty > 0 ? ` — ${info.dirty} file${info.dirty === 1 ? "" : "s"} changed` : " — clean"}
                  </div>
                  {info.files.length > 0 ? (
                    <div style={{ padding: 8 }}>
                      {info.files.map((f, i) => (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "6px 8px",
                            borderRadius: 6,
                            fontFamily: F.code,
                            fontSize: 12,
                            color: C.onSurfaceVariant,
                          }}
                        >
                          <span style={{ color: i < info.files.length ? C.tertiary : C.outline, flexShrink: 0 }}>
                            {f.startsWith("M") ? "M" : f.startsWith("A") ? "A" : f.startsWith("D") ? "D" : "?"}
                          </span>
                          <span style={{ wordBreak: "break-all" }}>{f.slice(3)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ padding: 16, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
                      {info.dirty === 0 ? "All changes committed." : "No file changes detected."}
                    </div>
                  )}
                </div>

                <Link
                  to={`/projects/${projectId}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 16,
                    fontFamily: F.code,
                    fontSize: 12,
                    fontWeight: 700,
                    color: C.secondary,
                    textDecoration: "none",
                  }}
                >
                  <Icon name="arrow_back" size={15} color="currentColor" />
                  Back to project
                </Link>
              </>
            )
          )}
      </div>
    </ProjectShell>
  );
}
