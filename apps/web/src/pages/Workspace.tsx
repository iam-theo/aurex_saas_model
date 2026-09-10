import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Workspace } from "../api";
import { C, F, Icon } from "../components/project-ui";

type Tab = "containers" | "logs" | "network" | "security";

interface WorkspaceStatus {
  id: string;
  status: string;
  containerId: string | null;
  image: string;
  path: string | null;
  resourceLimits: Record<string, unknown> | null;
  stats: { cpuPct: number; memUsed: number; memLimit: number; pids: number } | null;
  uptimeSeconds: number | null;
  processes: number | null;
  info: {
    image: string;
    created: string;
    started: string | null;
    running: boolean;
    restarts: number;
    pidsLimit: number | null;
    memoryLimit: number | null;
    nanoCpus: number | null;
    ipAddress: string | null;
    gateway: string | null;
    macAddress: string | null;
    networks: string[];
    ports: { exposed: string; hostIp: string | null; hostPort: string | null }[];
  } | null;
}

function fmtUptime(sec: number | null): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h.toString().padStart(2, "0")}h ${m.toString().padStart(2, "0")}m`;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m ${Math.floor(sec % 60)}s`;
}

function fmtBytes(n: number | null): string {
  if (n == null || n <= 0) return "—";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = n / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function Workspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [tab, setTab] = useState<Tab>("containers");
  const [logs, setLogs] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{ content?: string; binary?: boolean } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingLimits, setEditingLimits] = useState(false);
  const [limitCpus, setLimitCpus] = useState(2);
  const [limitMemory, setLimitMemory] = useState("4g");
  const [limitPids, setLimitPids] = useState(512);
  const [savingLimits, setSavingLimits] = useState(false);
  const [limitsMsg, setLimitsMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const running = status?.status === "running";

  const refreshStatus = useCallback(async (id: string) => {
    try {
      const s = await api.getWorkspaceStatus(id);
      setStatus(s);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  const refresh = useCallback(
    async (id: string) => {
      setBusy(true);
      const s = await refreshStatus(id);
      if (s?.status === "running") {
        setError(null);
        try {
          const f = await api.listWorkspaceFiles(id);
          setFiles(f.files);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
        if (tab === "logs") {
          setLogsLoading(true);
          try {
            const l = await api.getWorkspaceLogs(id);
            setLogs(l.logs);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setLogsLoading(false);
          }
        }
      }
      setBusy(false);
    },
    [refreshStatus, tab],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ws = await api.getMyWorkspace();
        if (cancelled) return;
        setWorkspace(ws);
        await refresh(ws.id);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!workspace || !running) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void refreshStatus(workspace.id);
    }, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [workspace, running, refreshStatus]);

  const switchTab = async (t: Tab) => {
    setTab(t);
    setError(null);
    if (!workspace) return;
    if (t === "logs" && status?.status === "running") {
      setLogsLoading(true);
      try {
        const l = await api.getWorkspaceLogs(workspace.id);
        setLogs(l.logs);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLogsLoading(false);
      }
    }
    if (t === "containers") {
      try {
        const f = await api.listWorkspaceFiles(workspace.id);
        setFiles(f.files);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const openFile = async (path: string) => {
    if (!workspace) return;
    setSelected(path);
    setFileError(null);
    setFileContent(null);
    try {
      const r = await api.readWorkspaceFile(workspace.id, path);
      if (r.ok) setFileContent({ content: r.content, binary: r.binary });
      else setFileError(r.error ?? "failed to read file");
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDestroy = async () => {
    if (!workspace || destroying) return;
    setDestroying(true);
    setError(null);
    try {
      await api.destroyWorkspace(workspace.id);
      setConfirmDestroy(false);
      await refresh(workspace.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDestroying(false);
    }
  };

  const recreate = async () => {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      await api.ensureMyWorkspace();
      let ok = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await refreshStatus(workspace.id);
        if (s?.status === "running") {
          ok = true;
          break;
        }
      }
      if (!ok) setError("workspace did not become ready yet — retry in a moment");
      await refresh(workspace.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Initialize editing state from current limits when entering edit mode.
  const startEditLimits = () => {
    const rl = status?.resourceLimits as Record<string, unknown> | null;
    setLimitCpus(Number(rl?.cpus) || 2);
    setLimitMemory(String(rl?.memory || "4g"));
    setLimitPids(Number(rl?.pids) || 512);
    setEditingLimits(true);
    setLimitsMsg(null);
  };

  const saveLimits = async () => {
    if (!workspace) return;
    setSavingLimits(true);
    setLimitsMsg(null);
    try {
      await api.updateWorkspaceLimits(workspace.id, {
        cpus: limitCpus,
        memory: limitMemory,
        pids: limitPids,
      });
      await refreshStatus(workspace.id);
      setEditingLimits(false);
      setLimitsMsg("Saved — changes apply on next respawn");
      setTimeout(() => setLimitsMsg(null), 4000);
    } catch (e) {
      setLimitsMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingLimits(false);
    }
  };

  const cpuPct = status?.stats?.cpuPct ?? 0;
  const memUsed = status?.stats?.memUsed ?? 0;
  const memLimit = status?.stats?.memLimit ?? status?.info?.memoryLimit ?? 0;
  const memPct = memLimit > 0 ? Math.min(100, Math.round((memUsed / memLimit) * 100)) : 0;

  const fileRows = useMemo(() => {
    return files.map((f) => {
      const clean = f.replace(/^\.\//, "");
      const depth = (clean.match(/\//g) ?? []).length;
      const name = clean.split("/").pop() ?? clean;
      return { path: clean, name, depth };
    });
  }, [files]);

  const label = "Personal Workspace";
  const sub = status?.info
    ? `${status.info.networks[0] ?? "docker"}${status.info.ipAddress ? ` · ${status.info.ipAddress}` : ""} · ${status.info.image}`
    : status?.image ?? "…";

  return (
    <div className="dash-main" style={{ overflowY: "auto", minWidth: 0 }}>
      {/* Top app bar */}
      <header
        style={{
          height: 56,
          flexShrink: 0,
          borderBottom: `1px solid ${C.outlineVariant}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <span style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.onSurfaceVariant, borderRight: `1px solid ${C.outlineVariant}`, paddingRight: 24 }}>
            Workspace Dashboard
          </span>
          <nav style={{ display: "flex", alignItems: "center", gap: 24 }}>
            {(
              [
                ["containers", "Containers"],
                ["logs", "Logs"],
                ["network", "Network"],
                ["security", "Security"],
              ] as [Tab, string][]
            ).map(([t, n]) => (
              <button
                key={t}
                onClick={() => void switchTab(t)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: F.code,
                  fontSize: 13,
                  color: tab === t ? C.primary : C.onSurfaceVariant,
                  fontWeight: tab === t ? 700 : 400,
                  padding: "0 0 6px",
                  borderBottom: tab === t ? `2px solid ${C.primary}` : "2px solid transparent",
                }}
              >
                {n}
              </button>
            ))}
          </nav>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {running ? (
            <button
              onClick={() => setConfirmDestroy(true)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: F.code,
                fontSize: 12,
                color: C.error,
                padding: "8px 12px",
                borderRadius: 8,
              }}
            >
              <Icon name="power_settings_new" size={16} color={C.error} />
              Destroy Workspace
            </button>
          ) : (
            <button
              onClick={() => void recreate()}
              disabled={busy}
              style={{
                background: C.primary,
                border: `1px solid ${C.primary}`,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: F.code,
                fontSize: 12,
                fontWeight: 700,
                color: C.onPrimary,
                padding: "8px 16px",
                borderRadius: 8,
                opacity: busy ? 0.6 : 1,
              }}
            >
              <Icon name="play_arrow" size={16} color={C.onPrimary} />
              {busy ? "Provisioning…" : "Respawn Dev Container"}
            </button>
          )}
        </div>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }}>
        {error && (
          <div style={{ background: "#93000a", border: `1px solid ${C.error}`, color: C.onErrorContainer, padding: "10px 14px", borderRadius: 8, fontFamily: F.code, fontSize: 12 }}>
            {error}
          </div>
        )}

        {/* Page title */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontFamily: F.display, fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em", color: C.onSurface, margin: 0 }}>
              {label}
            </h1>
            <p style={{ fontFamily: F.code, fontSize: 13, color: C.onSurfaceVariant, display: "flex", alignItems: "center", gap: 6, margin: "4px 0 0" }}>
              <Icon name="dns" size={16} color={C.onSurfaceVariant} />
              {sub}
            </p>
          </div>
        </div>

        {status?.status === "destroyed" ? (
          <div
            style={{
              background: C.surfaceContainerLow,
              border: `1px solid ${C.outlineVariant}`,
              borderRadius: 8,
              padding: 40,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              textAlign: "center",
            }}
          >
            <Icon name="cloud_off" size={40} color={C.outline} />
            <div>
              <h2 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, color: C.onSurface, margin: 0 }}>
                No Active Workspace Available
              </h2>
              <p style={{ fontFamily: F.body, fontSize: 14, color: C.onSurfaceVariant, margin: "8px 0 0", maxWidth: 480 }}>
                Respawn to create a new workspace container. This usually takes a few seconds.
              </p>
            </div>
            <button
              onClick={() => void recreate()}
              disabled={busy}
              style={{
                background: C.primary,
                border: `1px solid ${C.primary}`,
                cursor: "pointer",
                fontFamily: F.code,
                fontSize: 12,
                fontWeight: 700,
                color: C.onPrimary,
                padding: "10px 24px",
                borderRadius: 8,
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "Provisioning…" : "Respawn to Create a new Workspace Container"}
            </button>
          </div>
        ) : !status ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, fontFamily: F.code, fontSize: 13, color: C.onSurfaceVariant }}>
            <span style={{ width: 16, height: 16, borderRadius: 999, border: `2px solid ${C.outlineVariant}`, borderTopColor: C.primary, animation: "aurex-spin 0.8s linear infinite", marginRight: 12 }} />
            Loading workspace...
          </div>
        ) : (
          <>
            {/* Top row: telemetry + danger zone */}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)", gap: 24 }}>
              <div
                style={{
                  background: C.surfaceContainerLow,
                  border: `1px solid ${C.outlineVariant}`,
                  borderRadius: 8,
                  padding: 20,
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: "linear-gradient(90deg, transparent, rgba(78,222,163,0.5), transparent)" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                  <h2 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 600, color: C.onSurface, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                    <Icon name="memory" size={20} color={C.primary} />
                    Instance Telemetry
                  </h2>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      border: `1px solid rgba(78,222,163,0.3)`,
                      background: "rgba(78,222,163,0.1)",
                      color: C.primary,
                      fontFamily: F.code,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      padding: "4px 12px",
                      borderRadius: 999,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.primary }} />
                    {running ? "RUNNING" : status?.status?.toUpperCase() ?? "…"}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                  <div style={{ background: C.surfaceContainer, border: `1px solid ${C.outlineVariant}`, padding: 16, borderRadius: 8 }}>
                    <div style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <Icon name="schedule" size={14} color={C.onSurfaceVariant} />
                      Uptime
                    </div>
                    <div style={{ fontFamily: F.code, fontSize: 20, color: C.onSurface }}>{fmtUptime(status?.uptimeSeconds ?? null)}</div>
                  </div>
                  <div style={{ background: C.surfaceContainer, border: `1px solid ${C.outlineVariant}`, padding: 16, borderRadius: 8, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant, display: "flex", alignItems: "center", gap: 6 }}>
                        <Icon name="speed" size={14} color={C.onSurfaceVariant} />
                        CPU Load
                      </div>
                      <span style={{ fontFamily: F.code, fontSize: 11, color: C.primary }}>{cpuPct}%</span>
                    </div>
                    <div style={{ width: "100%", background: C.surfaceContainerHighest, height: 6, borderRadius: 999, overflow: "hidden" }}>
                      <div style={{ background: C.primary, height: "100%", width: `${Math.min(100, cpuPct)}%`, borderRadius: 999 }} />
                    </div>
                  </div>
                  <div style={{ background: C.surfaceContainer, border: `1px solid ${C.outlineVariant}`, padding: 16, borderRadius: 8, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant, display: "flex", alignItems: "center", gap: 6 }}>
                        <Icon name="storage" size={14} color={C.onSurfaceVariant} />
                        RAM Usage
                      </div>
                      <span style={{ fontFamily: F.code, fontSize: 11, color: C.secondary }}>
                        {fmtBytes(memUsed)} / {fmtBytes(memLimit)}
                      </span>
                    </div>
                    <div style={{ width: "100%", background: C.surfaceContainerHighest, height: 6, borderRadius: 999, overflow: "hidden" }}>
                      <div style={{ background: C.secondary, height: "100%", width: `${memPct}%`, borderRadius: 999 }} />
                    </div>
                  </div>
                </div>
              </div>

              <div
                style={{
                  background: "#1a0f12",
                  border: `1px solid rgba(255,180,171,0.2)`,
                  borderRadius: 8,
                  padding: 20,
                  position: "relative",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: "linear-gradient(90deg, transparent, rgba(255,180,171,0.5), transparent)" }} />
                <h2 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 600, color: C.error, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="warning" size={20} color={C.error} />
                  Danger Zone
                </h2>
                <p style={{ fontFamily: F.body, fontSize: 13, lineHeight: 1.6, color: C.onSurfaceVariant, margin: "0 0 auto" }}>
                  Permanently destroy this workspace and all projects in it, including their volumes and published
                  sites. This action cannot be undone.
                </p>
                <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid rgba(255,180,171,0.1)` }}>
                  <button
                    onClick={() => setConfirmDestroy(true)}
                    style={{
                      width: "100%",
                      background: C.error,
                      color: C.onErrorContainer,
                      border: "none",
                      cursor: "pointer",
                      padding: "10px 0",
                      borderRadius: 8,
                      fontFamily: F.code,
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                    }}
                  >
                    <Icon name="delete_forever" size={18} color={C.onErrorContainer} />
                    Destroy Workspace
                  </button>
                </div>
              </div>
            </div>

            {/* Tab body */}
            {tab === "containers" && (
              <div style={{ background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 8, display: "flex", flexDirection: "column", minHeight: 400, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.outlineVariant}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surfaceContainer, borderTopLeftRadius: 8, borderTopRightRadius: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.code, fontSize: 13, color: C.onSurfaceVariant }}>
                    <Icon name="laptop_windows" size={18} color={C.onSurfaceVariant} />
                    <span>workspace</span>
                    <span style={{ color: C.outline }}>/</span>
                    <span style={{ color: C.onSurface }}>files</span>
                  </div>
                  <button
                    onClick={() => void switchTab("containers")}
                    style={{ background: "none", border: "none", cursor: "pointer", width: 28, height: 28, borderRadius: 6, display: "grid", placeItems: "center", color: C.onSurfaceVariant }}
                    title="Refresh"
                  >
                    <Icon name="refresh" size={18} />
                  </button>
                </div>
                <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                  <div style={{ width: "min(320px, 30%)", minWidth: 200, flexShrink: 0, borderRight: `1px solid ${C.outlineVariant}`, overflowY: "auto" }}>
                    {fileRows.length === 0 ? (
                      <div style={{ padding: 24, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant, textAlign: "center" }}>
                        No files found
                      </div>
                    ) : (
                      fileRows.map((f) => (
                        <button
                          key={f.path}
                          onClick={() => void openFile(f.path)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            width: "100%",
                            textAlign: "left",
                            padding: "8px 12px",
                            paddingLeft: 12 + f.depth * 16,
                            background: selected === f.path ? "rgba(78,222,163,0.08)" : "none",
                            border: "none",
                            borderBottom: `1px solid rgba(60,74,66,0.25)`,
                            cursor: "pointer",
                            fontFamily: F.code,
                            fontSize: 12,
                            color: selected === f.path ? C.primary : C.onSurface,
                          }}
                        >
                          <Icon name="code" size={16} color={selected === f.path ? C.primary : C.onSurfaceVariant} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 20, fontFamily: F.code, fontSize: 12, lineHeight: 1.6, color: C.onSurface }}>
                    {fileError ? (
                      <div style={{ color: C.error }}>{fileError}</div>
                    ) : fileContent ? (
                      fileContent.binary ? (
                        <div style={{ color: C.onSurfaceVariant }}>Binary file — preview not available.</div>
                      ) : (
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{fileContent.content}</pre>
                      )
                    ) : (
                      <div style={{ color: C.onSurfaceVariant, textAlign: "center", paddingTop: 40 }}>
                        Select a file to view its contents
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {tab === "logs" && (
              <div style={{ background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 8, overflow: "hidden", minHeight: 400 }}>
                <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.outlineVariant}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.surfaceContainer }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.code, fontSize: 13, color: C.onSurfaceVariant }}>
                    <Icon name="terminal" size={18} color={C.onSurfaceVariant} />
                    Container logs
                  </div>
                  <button
                    onClick={() => void switchTab("logs")}
                    disabled={logsLoading}
                    style={{ background: "none", border: "none", cursor: "pointer", width: 28, height: 28, borderRadius: 6, display: "grid", placeItems: "center", color: C.onSurfaceVariant, opacity: logsLoading ? 0.5 : 1 }}
                    title="Refresh"
                  >
                    <Icon name="refresh" size={18} />
                  </button>
                </div>
                <div style={{ padding: 16, overflowY: "auto", maxHeight: 480, fontFamily: F.code, fontSize: 11, lineHeight: 1.6, color: C.onSurfaceVariant }}>
                  {logsLoading ? (
                    "loading…"
                  ) : logs ? (
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{logs}</pre>
                  ) : (
                    "No log output yet."
                  )}
                </div>
              </div>
            )}

            {tab === "network" && (
              <div style={{ background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 8, overflow: "hidden", minHeight: 400 }}>
                <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.outlineVariant}`, background: C.surfaceContainer }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.code, fontSize: 13, color: C.onSurfaceVariant }}>
                    <Icon name="hub" size={18} color={C.onSurfaceVariant} />
                    Network
                  </span>
                </div>
                <div style={{ padding: 20 }}>
                  <NetTable rows={[
                    ["Network", status?.info?.networks?.join(", ") || "—"],
                    ["IP Address", status?.info?.ipAddress || "—"],
                    ["Gateway", status?.info?.gateway || "—"],
                    ["MAC Address", status?.info?.macAddress || "—"],
                    ["Restarts", status?.info ? String(status.info.restarts) : "—"],
                    ["Created", fmtDate(status?.info?.created ?? null)],
                    ["Started", fmtDate(status?.info?.started ?? null)],
                  ]} />
                  {status?.info?.ports && status.info.ports.length > 0 && (
                    <>
                      <div style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant, margin: "24px 0 8px" }}>
                        Port bindings
                      </div>
                      <NetTable rows={status.info.ports.map((p) => [`${p.exposed} → ${p.hostIp ?? "0.0.0.0"}:${p.hostPort ?? ""}`, "bound"])} />
                    </>
                  )}
                </div>
              </div>
            )}

            {tab === "security" && (
              <div style={{ background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 8, overflow: "hidden", minHeight: 400 }}>
                <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.outlineVariant}`, background: C.surfaceContainer, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.code, fontSize: 13, color: C.onSurfaceVariant }}>
                    <Icon name="security" size={18} color={C.onSurfaceVariant} />
                    Security & resources
                  </span>
                  {!editingLimits && (
                    <button
                      onClick={startEditLimits}
                      style={{
                        display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 6,
                        background: "transparent", border: `1px solid ${C.outlineVariant}`, color: C.onSurface,
                        fontFamily: F.code, fontSize: 11, cursor: "pointer",
                      }}
                    >
                      <Icon name="edit" size={13} color="currentColor" />
                      Edit Limits
                    </button>
                  )}
                </div>
                <div style={{ padding: 20 }}>
                  <NetTable rows={[
                    ["Image", status?.info?.image || status?.image || "—"],
                    ["CPU quota", status?.info?.nanoCpus ? `${(status.info.nanoCpus / 1e9).toFixed(0)} cores` : "unlimited"],
                    ["Memory limit", status?.info?.memoryLimit ? fmtBytes(status.info.memoryLimit) : "unlimited"],
                    ["PIDs limit", status?.info?.pidsLimit != null ? String(status.info.pidsLimit) : "unlimited"],
                    ["Running processes", status?.processes != null ? String(status.processes) : "—"],
                    ["Isolation", "Docker container (aurex-workspace)"],
                  ]} />

                  {/* Editable resource limits */}
                  <div style={{ marginTop: 24, borderTop: `1px solid ${C.outlineVariant}`, paddingTop: 20 }}>
                    <div style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                      <Icon name="tune" size={14} color={C.onSurfaceVariant} />
                      Desired Limits
                      <span style={{ fontWeight: 400, fontSize: 10, color: C.outline, marginLeft: 4 }}>
                        (applied on next respawn)
                      </span>
                    </div>
                    {editingLimits ? (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                        <LimitField label="CPU Cores" value={limitCpus} onChange={setLimitCpus} type="number" min={1} max={16} />
                        <LimitField label="Memory" value={limitMemory} onChange={setLimitMemory} type="text" placeholder="4g" />
                        <LimitField label="Max PIDs" value={limitPids} onChange={setLimitPids} type="number" min={64} max={4096} />
                      </div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                        <LimitDisplay label="CPU Cores" value={String((status?.resourceLimits as any)?.cpus ?? 2)} />
                        <LimitDisplay label="Memory" value={String((status?.resourceLimits as any)?.memory ?? "4g")} />
                        <LimitDisplay label="Max PIDs" value={String((status?.resourceLimits as any)?.pids ?? 512)} />
                      </div>
                    )}
                    {editingLimits && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
                        <button
                          onClick={() => void saveLimits()}
                          disabled={savingLimits}
                          style={{
                            display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 6,
                            background: C.primary, color: "#000", border: "none", fontFamily: F.code, fontSize: 12, fontWeight: 700,
                            cursor: savingLimits ? "default" : "pointer", opacity: savingLimits ? 0.6 : 1,
                          }}
                        >
                          <Icon name="save" size={14} color="#000" />
                          {savingLimits ? "Saving…" : "Save"}
                        </button>
                        <button
                          onClick={() => { setEditingLimits(false); setLimitsMsg(null); }}
                          disabled={savingLimits}
                          style={{
                            padding: "7px 16px", borderRadius: 6, background: "transparent",
                            color: C.onSurface, border: `1px solid ${C.outlineVariant}`,
                            fontFamily: F.code, fontSize: 12, cursor: savingLimits ? "default" : "pointer",
                          }}
                        >
                          Cancel
                        </button>
                        {limitsMsg && (
                          <span style={{ fontFamily: F.code, fontSize: 11, color: limitsMsg.includes("Saved") ? C.primary : C.error }}>
                            {limitsMsg}
                          </span>
                        )}
                      </div>
                    )}
                    {!editingLimits && limitsMsg && (
                      <div style={{ marginTop: 8, fontFamily: F.code, fontSize: 11, color: C.primary }}>{limitsMsg}</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {confirmDestroy && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: 440,
              maxWidth: "90vw",
              background: C.surfaceContainerHigh,
              border: `1px solid ${C.outlineVariant}`,
              borderRadius: 12,
              padding: 24,
            }}
          >
            <h3 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, color: C.error, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="warning" size={20} color={C.error} />
              Destroy this workspace?
            </h3>
            <p style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.6, color: C.onSurfaceVariant, margin: "12px 0 0" }}>
              The container will be removed from the host and every project in this workspace — its code, runs, files
              and any published site — will be deleted entirely. The workspace record is kept so you can respawn a fresh
              dev container before your next project. This cannot be undone.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 24 }}>
              <button
                onClick={() => setConfirmDestroy(false)}
                disabled={destroying}
                style={{ background: "none", border: `1px solid ${C.outlineVariant}`, color: C.onSurface, cursor: "pointer", padding: "8px 18px", borderRadius: 8, fontFamily: F.code, fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                onClick={() => void doDestroy()}
                disabled={destroying}
                style={{ background: C.error, border: "none", color: C.onErrorContainer, cursor: "pointer", padding: "8px 18px", borderRadius: 8, fontFamily: F.code, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 8, opacity: destroying ? 0.6 : 1 }}
              >
                <Icon name="delete_forever" size={16} color={C.onErrorContainer} />
                {destroying ? "Destroying…" : "Destroy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LimitField({
  label,
  value,
  onChange,
  type,
  min,
  max,
  placeholder,
}: {
  label: string;
  value: number | string;
  onChange: (v: any) => void;
  type?: string;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: C.onSurfaceVariant }}>
        {label}
      </label>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(type === "number" ? Number(e.target.value) : e.target.value)}
        min={min}
        max={max}
        placeholder={placeholder}
        style={{
          padding: "8px 12px", borderRadius: 6, border: `1px solid ${C.outlineVariant}`,
          background: C.surfaceContainerLowest, color: C.onSurface,
          fontFamily: F.code, fontSize: 13, outline: "none", width: "100%",
        }}
      />
    </div>
  );
}

function LimitDisplay({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: C.onSurfaceVariant }}>
        {label}
      </span>
      <span style={{ fontFamily: F.code, fontSize: 13, color: C.onSurface, padding: "8px 0" }}>
        {value}
      </span>
    </div>
  );
}

function NetTable({ rows }: { rows: [string, string][] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: F.code, fontSize: 12 }}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} style={{ borderBottom: `1px solid rgba(60,74,66,0.4)` }}>
            <td style={{ padding: "8px 12px", color: C.onSurfaceVariant, width: 220, whiteSpace: "nowrap" }}>{k}</td>
            <td style={{ padding: "8px 12px", color: C.onSurface }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
