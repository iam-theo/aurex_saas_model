import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, displayModel, type ModelInfo, type Project } from "../api";
import { useAuth } from "../auth";
import { C, F, GAP, PAD, Icon, Avatar } from "../components/project-ui";
import { getPreferredModel, setPreferredModel } from "../modelPref";
import { useSidebar } from "../hooks/useSidebar";
import Workspace from "./Workspace";


const ARCHITECT_GUIDANCE = [
  "",
  "⛔ MANDATORY DISCOVERY PROTOCOL — DO NOT WRITE CODE YET",
  "",
  "Before you write ANY code, you MUST act as a senior product architect and call the `question` tool. Do not scaffold, install, or generate files until the user has answered.",
  "You are to use the `question` tool (interactive, not markdown lists) with 3-6 enterprise questions. Put your ⭐ recommended option FIRST with a strong engineering argument.",
  "",
  "Cover at minimum:",
  "- Product scope: target users, core workflows, what the first deliverable should be and what is OUT of scope",
  "- Tech stack & architecture: frontend framework, backend, database, and hosting — with WHY for your recommendation",
  "- Authentication, authorization, and user roles",
  "- Data model & storage + file/media/search",
  "- Third-party integrations and APIs (payments, email, AI, etc.)",
  "- Security, performance, scale, reliability, and cost — what happens at 10x/100x",
  "- Testing strategy and deployment target",
  "",
  "For each question, propose 2-5 concrete options with the recommended default FIRST. Use custom:true so the user can type a custom answer. Wait for answers before building. After answers, synthesize a Build Plan (Product Summary, Requirements, Architecture, Recommended Stack with WHY, Database Design, API Design, Security Model, Folder Structure, Phases) then build.",
].join("\n");

type DashboardView = "apps" | "workspace" | "myapps";

const DASH_MODEL_KEY = "aurex.dash.model";

function getDashModel(): string {
  try { return localStorage.getItem(DASH_MODEL_KEY) || ""; } catch { return ""; }
}
function setDashModel(m: string) {
  try { localStorage.setItem(DASH_MODEL_KEY, m); } catch { /* */ }
}

function generateProjectName(prompt: string): string {
  const clean = prompt
    .replace(/\b(create|build|make|design|develop|generate|implement|write|code|an|a|the|for|with|and|of|in|on|to|that|this|using|like|want|need|should|would|can|app|website|page|project|system|platform)\b/gi, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return clean || "New App";
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<DashboardView>("apps");
  const [respawnPrompt, setRespawnPrompt] = useState<string | null>(null);
  const [respawning, setRespawning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(getDashModel);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { open: sidebarOpen, toggle: toggleSidebar, width: sidebarWidth } = useSidebar();
  const [ghostText, setGhostText] = useState("");
  const pastTasksRef = useRef<string[]>([]);

  // Build ghost text suggestion from past project tasks
  useEffect(() => {
    const text = prompt;
    if (!text || text.length < 3) { setGhostText(""); return; }
    const tasks = pastTasksRef.current;
    if (tasks.length === 0) { setGhostText(""); return; }
    const lower = text.toLowerCase();
    // Find the best matching past task that starts with or contains the current input
    let best = "";
    for (const task of tasks) {
      const tLower = task.toLowerCase();
      if (tLower.startsWith(lower) && tLower.length > lower.length) {
        if (task.length > best.length) best = task;
      }
    }
    // If no prefix match, try contains match (shorter tasks first)
    if (!best) {
      let bestScore = 0;
      for (const task of tasks) {
        const tLower = task.toLowerCase();
        if (tLower.includes(lower)) {
          // Prefer shorter, more relevant matches
          const score = lower.length / tLower.length;
          if (score > bestScore) { bestScore = score; best = task; }
        }
      }
    }
    if (best) {
      // Show only the remaining part after what the user typed
      const remaining = best.slice(text.length);
      setGhostText(remaining.length > 200 ? remaining.slice(0, 200) + "..." : remaining);
    } else {
      setGhostText("");
    }
  }, [prompt]);

  const load = useCallback(async () => {
    try {
      const [projs, mdl] = await Promise.all([api.listProjects(), api.listModels()]);
      setProjects(projs);
      const allModels: ModelInfo[] = [];
      const data = mdl as unknown as { opencode?: ModelInfo[]; aurextra?: ModelInfo[]; custom?: ModelInfo[] };
      if (data.opencode) allModels.push(...data.opencode);
      if (data.aurextra) allModels.push(...data.aurextra);
      if (data.custom) allModels.push(...data.custom);
      setModels(allModels);
      // Pick a default model if none is selected yet.
      const saved = getDashModel();
      if (!saved || !allModels.some((m) => m.id === saved)) {
        const def = allModels.find((m) => m.isDefault)?.id ?? allModels[0]?.id ?? "";
        setSelectedModel(def);
        setDashModel(def);
      }
      // Populate past tasks for ghost text auto-completion
      const tasks = projs
        .map((p) => p.description)
        .filter((d): d is string => !!d && d.length > 5);
      pastTasksRef.current = tasks;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [userMenuOpen]);

  const pickModel = (id: string) => {
    setSelectedModel(id);
    setDashModel(id);
  };

  const startProject = async (text: string) => {
    setGenerating(true);
    setError(null);
    let project: Project | null = null;
    try {
      const name = generateProjectName(text);
      project = await api.createProject(name, text);
      const attachmentIds: string[] = [];
      for (const file of attachments) {
        try {
          const res = await api.uploadAttachment(project.id, file);
          attachmentIds.push(res.attachment.id);
        } catch (uploadErr) {
          setError(`Failed to upload "${file.name}": ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
          setGenerating(false);
          return;
        }
      }
      const run = await api.createRun(
        project.id,
        `${text}\n${ARCHITECT_GUIDANCE}`,
        selectedModel || undefined,
        attachmentIds.length > 0 ? attachmentIds : undefined,
      );
      navigate(`/runs/${run.id}`);
    } catch (err) {
      if (project) { navigate(`/projects/${project.id}`); return; }
      if (err instanceof Error && err.message === "workspace_destroyed") {
        setRespawnPrompt(text);
        setGenerating(false);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setGenerating(false);
    }
  };

  const generate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || generating) return;
    await startProject(text);
  };

  const respawnAndRetry = async () => {
    if (!respawnPrompt || respawning) return;
    setRespawning(true);
    setError(null);
    try {
      await api.ensureMyWorkspace();
      const ws = await api.getMyWorkspace();
      let ready = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await api.getWorkspaceStatus(ws.id);
        if (s.status === "running") { ready = true; break; }
      }
      if (!ready) throw new Error("Dev container did not become ready yet — please retry in a moment.");
      const text = respawnPrompt;
      setRespawnPrompt(null);
      await startProject(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRespawning(false);
    }
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachments((prev) => [...prev, ...Array.from(files)]);
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const focusNew = () => { setView("apps"); inputRef.current?.focus(); };

  const navItem = (icon: string, label: string, active: boolean, onClick: () => void) =>
    active ? (
      <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: C.secondaryContainer, color: C.onSecondaryContainer, borderRadius: 8, fontWeight: 700 }}>
        <Icon name={icon} size={18} color={C.onSecondaryContainer} fill />
        <span style={{ fontFamily: F.code, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</span>
      </div>
    ) : (
      <button key={label} onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", color: C.onSurfaceVariant, background: "transparent", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: F.code, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left", transition: "all 0.2s" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = C.onSurface; e.currentTarget.style.background = C.surfaceContainerHigh; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = C.onSurfaceVariant; e.currentTarget.style.background = "transparent"; }}
      >
        <Icon name={icon} size={18} color="currentColor" />
        {label}
      </button>
    );

  return (
    <div style={{ display: "flex", height: "100vh", width: "100%", overflow: "hidden", background: C.background, color: C.onBackground, fontFamily: F.body, fontSize: 14, lineHeight: 1.6 }}>
      {/* Sidebar */}
      <nav style={{ display: "flex", flexDirection: "column", height: "100%", padding: sidebarOpen ? `${PAD}px 0` : "12px 0", gap: GAP, background: C.surfaceContainerLow, borderRight: `1px solid ${C.outlineVariant}`, width: sidebarWidth, minWidth: sidebarWidth, flexShrink: 0, position: "relative", zIndex: 20, overflow: "hidden", transition: "width 0.2s ease, min-width 0.2s ease, padding 0.2s ease" }}>
        {/* Toggle button */}
        <div style={{ padding: `0 ${PAD}px`, marginBottom: sidebarOpen ? 24 : 12, display: "flex", justifyContent: sidebarOpen ? "flex-end" : "center" }}>
          <button onClick={toggleSidebar} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 8, background: "transparent", border: `1px solid ${C.outlineVariant}`, color: C.onSurfaceVariant, cursor: "pointer", transition: "background 0.15s" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceContainerHigh; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <Icon name={sidebarOpen ? "menu_open" : "menu"} size={18} color="currentColor" />
          </button>
        </div>

        {sidebarOpen && (
          <>
            <div style={{ padding: `0 ${PAD}px`, marginBottom: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: C.primary, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontFamily: F.display, fontSize: 14, fontWeight: 800, color: "#000" }}>A</span>
                </div>
                <div>
                  <div style={{ fontFamily: F.display, fontSize: 15, fontWeight: 700, color: C.onSurface, lineHeight: 1.2 }}>Aurex</div>
                </div>
              </div>
            </div>

            <div style={{ padding: `0 ${PAD}px`, marginBottom: 24 }}>
              <button onClick={() => navigate("/import")} style={{ display: "flex", width: "100%", background: "transparent", color: C.primary, fontFamily: F.code, fontSize: 11, fontWeight: 700, padding: "8px 16px", borderRadius: 8, border: `1px solid ${C.outlineVariant}`, alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", transition: "border-color 0.15s, background 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.primary; e.currentTarget.style.background = "rgba(78,222,163,0.08)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.outlineVariant; e.currentTarget.style.background = "transparent"; }}
              >
                <Icon name="drive_folder_upload" size={15} color="currentColor" />
                Import
              </button>
            </div>

            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, padding: "0 12px", overflowY: "auto" }}>
              <div style={{ fontFamily: F.code, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: C.outline, padding: "0 8px 6px" }}>Build</div>
              {navItem("add_circle", "New App", view === "apps", focusNew)}
              {navItem("grid_view", "My Apps", view === "myapps", () => setView("myapps"))}

              <div style={{ fontFamily: F.code, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: C.outline, padding: "16px 8px 6px" }}>Manage</div>
              {navItem("dns", "Workspace", view === "workspace", () => setView("workspace"))}

              <button disabled style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", color: C.outline, background: "transparent", border: "none", borderRadius: 8, cursor: "default", fontFamily: F.code, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", textAlign: "left", opacity: 0.6 }}>
                <Icon name="hub" size={18} color="currentColor" />
                Integration Hub
                <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 700, color: C.outline, background: C.surfaceContainerHigh, padding: "2px 7px", borderRadius: 999 }}>soon</span>
              </button>
            </div>

            {/* User avatar — clickable dropdown */}
            <div ref={userMenuRef} style={{ padding: PAD, borderTop: `1px solid ${C.outlineVariant}`, flexShrink: 0, position: "relative" }}>
              <button
                onClick={() => setUserMenuOpen((o) => !o)}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", background: "transparent", border: "none", cursor: "pointer", padding: "6px 8px", borderRadius: 8, transition: "background 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceContainerHigh; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <Avatar src={user?.avatarUrl} name={user?.name ?? user?.email} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: C.outline, textAlign: "left" }}>{user?.email ?? "..."}</span>
                <span style={{ fontSize: 10, color: C.outline, transition: "transform 0.2s", transform: userMenuOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
              </button>
              {userMenuOpen && (
                <div style={{ position: "absolute", bottom: "100%", left: PAD, right: PAD, marginBottom: 8, background: C.surfaceContainerHigh, border: `1px solid ${C.outlineVariant}`, borderRadius: 10, padding: 14, zIndex: 50, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <Avatar src={user?.avatarUrl} name={user?.name ?? user?.email} />
                    <div>
                      <div style={{ fontFamily: F.display, fontSize: 13, fontWeight: 600, color: C.onSurface }}>{user?.name ?? "User"}</div>
                      <div style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>{user?.email}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => void logout()}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.outlineVariant}`, background: "transparent", color: C.error, fontFamily: F.code, fontSize: 12, cursor: "pointer", transition: "background 0.15s" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = `${C.error}12`; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <Icon name="logout" size={14} color="currentColor" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Collapsed mode: icon-only nav */}
        {!sidebarOpen && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "0 4px", marginTop: 28, overflowY: "auto" }}>
            <button onClick={() => navigate("/import")} title="Import" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 8, background: "transparent", border: `1px solid ${C.outlineVariant}`, color: C.primary, cursor: "pointer" }}>
              <Icon name="drive_folder_upload" size={18} color="currentColor" />
            </button>
            <button onClick={() => setView("myapps")} title="My Apps" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 8, background: view === "myapps" ? C.surfaceContainerHigh : "transparent", border: "none", color: view === "myapps" ? C.primary : C.onSurfaceVariant, cursor: "pointer" }}>
              <Icon name="grid_view" size={18} color="currentColor" />
            </button>
            <button onClick={() => setView("workspace")} title="Workspace" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 8, background: view === "workspace" ? C.surfaceContainerHigh : "transparent", border: "none", color: view === "workspace" ? C.primary : C.onSurfaceVariant, cursor: "pointer" }}>
              <Icon name="dns" size={18} color="currentColor" />
            </button>
          </div>
        )}
      </nav>

      {/* Main */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: C.surface, overflow: "hidden" }}>
        {view === "workspace" ? (
          <Workspace />
        ) : view === "myapps" ? (
          /* My Apps view */
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h1 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, color: C.onSurface, margin: 0 }}>My Apps</h1>
                <span style={{ fontFamily: F.code, fontSize: 11, fontWeight: 600, color: C.onSurfaceVariant, background: C.surfaceContainerHigh, padding: "2px 8px", borderRadius: 999 }}>{projects.length}</span>
                <div style={{ flex: 1 }} />
                <button onClick={focusNew} style={{ display: "flex", alignItems: "center", gap: 6, background: C.primary, color: "#000", border: "none", borderRadius: 8, fontFamily: F.code, fontSize: 11, fontWeight: 700, padding: "7px 14px", cursor: "pointer", transition: "opacity 0.15s" }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                >
                  <Icon name="add" size={14} color="#000" />
                  New App
                </button>
              </div>
              {projects.length === 0 ? (
                <div style={{ textAlign: "center", border: `1px dashed ${C.outlineVariant}`, borderRadius: 12, padding: "56px 24px", background: C.surfaceContainerLow }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: C.surfaceContainerHigh, display: "grid", placeItems: "center", margin: "0 auto 16px" }}>
                    <Icon name="deployed_code" size={20} color={C.outline} />
                  </div>
                  <p style={{ fontFamily: F.body, fontSize: 14, color: C.onSurfaceVariant, margin: "0 0 4px" }}>No apps yet</p>
                  <p style={{ fontFamily: F.code, fontSize: 12, color: C.outline, margin: 0 }}>Describe your idea and Aurex will build it for you.</p>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                  {projects.map((p) => (
                    <Link key={p.id} to={`/projects/${p.id}`}
                      style={{ display: "flex", flexDirection: "column", gap: 10, background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 10, padding: 16, textDecoration: "none", color: "inherit", transition: "border-color 0.15s, box-shadow 0.15s", overflow: "hidden" }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.outline; e.currentTarget.style.boxShadow = "0 8px 24px -8px rgba(0,0,0,0.4)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.outlineVariant; e.currentTarget.style.boxShadow = "none"; }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: C.surfaceContainerHigh, display: "grid", placeItems: "center", flexShrink: 0 }}>
                          <Icon name="deployed_code" size={16} color={C.primary} />
                        </div>
                        <h3 style={{ fontFamily: F.display, fontSize: 13, fontWeight: 600, color: C.onSurface, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{p.name}</h3>
                      </div>
                      <div style={{ fontFamily: F.code, fontSize: 10, color: C.outline, display: "flex", alignItems: "center", gap: 8, borderTop: `1px solid ${C.outlineVariant}40`, paddingTop: 8, marginTop: "auto" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: p.status === "running" ? "#4edea3" : p.status === "error" ? C.error : C.outline, flexShrink: 0 }} />
                          {p.status}
                        </span>
                        <span>{(p._count?.runs ?? 0)} run{((p._count?.runs ?? 0) === 1 ? "" : "s")}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
          </div>
        ) : (
          /* Hero — ChatGPT-style centered layout */
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", overflow: "auto" }}>
            <div style={{ width: "100%", maxWidth: 640, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <h1 style={{ fontFamily: F.display, fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", color: C.onSurface, margin: "0 0 6px", textAlign: "center", flexShrink: 0 }}>
              Build with{" "}
              <span style={{ color: C.primary }}>Aurex</span>
            </h1>
            <p style={{ fontFamily: F.body, fontSize: 14, color: C.onSurfaceVariant, margin: "0 0 28px", textAlign: "center", flexShrink: 0 }}>
              Describe your project and Aurex will build it.
            </p>

            {/* Input card */}
            <div style={{ position: "relative", width: "100%", flexShrink: 0 }}>
              <div style={{ background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 14, boxShadow: "0 16px 48px -12px rgba(0,0,0,0.5)" }}>
                <div style={{ position: "relative" }}>
                  {/* Ghost text overlay */}
                  {ghostText && !generating && (
                    <div
                      aria-hidden
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        pointerEvents: "none",
                        fontFamily: F.body,
                        fontSize: 15,
                        lineHeight: 1.6,
                        padding: "16px 16px 4px",
                        color: C.onSurfaceVariant,
                        opacity: 0.35,
                        whiteSpace: "pre-wrap",
                        overflow: "hidden",
                      }}
                    >
                      <span style={{ visibility: "hidden" }}>{prompt}</span>{ghostText}
                    </div>
                  )}
                  <textarea
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void generate(); }
                      if (e.key === "Tab" && ghostText) {
                        e.preventDefault();
                        setPrompt((prev) => prev + ghostText);
                        setGhostText("");
                      }
                    }}
                    placeholder="What do you want to build?"
                    rows={3}
                    disabled={generating}
                    style={{ display: "block", width: "100%", background: "transparent", border: "none", color: C.onSurface, fontFamily: F.body, fontSize: 15, lineHeight: 1.6, padding: "16px 16px 4px", resize: "none", outline: "none", minHeight: 72, position: "relative", zIndex: 1 }}
                  />
                </div>

                {/* Bottom bar */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px 10px" }}>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flex: 1, minWidth: 0 }}>
                    <div style={{ position: "relative" }}>
                      <select
                        value={selectedModel}
                        onChange={(e) => pickModel(e.target.value)}
                        style={{
                          appearance: "none",
                          background: C.surfaceContainerHigh,
                          border: `1px solid ${C.outlineVariant}`,
                          borderRadius: 999,
                          color: C.onSurface,
                          fontFamily: F.code,
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "7px 28px 7px 12px",
                          cursor: "pointer",
                          outline: "none",
                          maxWidth: 180,
                          transition: "border-color 0.15s",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.primary; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.outlineVariant; }}
                       >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label ?? displayModel(m.id)}
                            {m.isDefault && " (Default)"}
                          </option>
                        ))}
                      </select>
                    </div>

                    <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { void pickFiles(e.target.files); e.target.value = ""; }} />
                    <button type="button" title="Attach files" onClick={() => fileInputRef.current?.click()}
                      style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, border: "none", borderRadius: 999, cursor: "pointer", background: "transparent", color: C.onSurfaceVariant, transition: "all 0.2s" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceContainerHigh; e.currentTarget.style.color = C.onSurface; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.onSurfaceVariant; }}
                    >
                      <Icon name="attach_file" size={18} color="currentColor" />
                    </button>

                    {attachments.length > 0 && (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                        {attachments.map((f, i) => (
                          <span key={`${f.name}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: C.surfaceContainerHigh, border: `1px solid ${C.outlineVariant}`, borderRadius: 999, fontFamily: F.code, fontSize: 10, color: C.onSurfaceVariant, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {f.name}
                            <button type="button" onClick={() => removeAttachment(i)} style={{ background: "none", border: "none", color: C.onSurfaceVariant, cursor: "pointer", padding: 0, display: "flex", lineHeight: 1 }}>
                              <Icon name="close" size={12} color="currentColor" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <button type="submit" onClick={() => void generate()} disabled={!prompt.trim() || generating}
                    style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.surfaceContainerHigh, color: C.onSurface, border: `1px solid ${C.outlineVariant}`, borderRadius: 999, fontFamily: F.code, fontSize: 13, fontWeight: 500, padding: "9px 18px", cursor: !prompt.trim() || generating ? "not-allowed" : "pointer", opacity: !prompt.trim() || generating ? 0.5 : 1, transition: "all 0.2s", flexShrink: 0 }}
                    onMouseEnter={(e) => { if (!e.currentTarget.disabled) { e.currentTarget.style.background = C.surfaceContainerHighest; e.currentTarget.style.borderColor = C.primary; } }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = C.surfaceContainerHigh; e.currentTarget.style.borderColor = C.outlineVariant; }}
                  >
                    <Icon name="auto_awesome" size={14} color={C.primary} />
                    {generating ? "Starting agent..." : "Build"}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div style={{ width: "100%", textAlign: "left", marginTop: 16, padding: "10px 14px", borderRadius: 8, background: `${C.error}15`, border: `1px solid ${C.error}40`, color: C.error, fontFamily: F.code, fontSize: 12 }}>
                {error}
              </div>
            )}
            </div>
          </div>
        )}
      </main>

      {/* Respawn Modal */}
      {respawnPrompt !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ width: 460, maxWidth: "90vw", background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 12, padding: 24 }}>
            <div style={{ width: 40, height: 40, borderRadius: 8, background: C.primaryContainer, display: "grid", placeItems: "center", color: C.onPrimaryContainer, marginBottom: 16 }}>
              <Icon name="auto_awesome" size={20} color={C.onPrimaryContainer} />
            </div>
            <h3 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, color: C.onSurface, margin: 0 }}>Respawn your dev container</h3>
            <p style={{ fontFamily: F.body, fontSize: 14, lineHeight: 1.6, color: C.onSurfaceVariant, margin: "12px 0 0" }}>
              Your previous dev container was destroyed. Before a new project can be created, Aurex needs to provision a fresh isolated dev container for you. This usually takes a few seconds.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 24 }}>
              <button onClick={() => { setRespawnPrompt(null); setRespawning(false); }} disabled={respawning} style={{ background: "transparent", border: `1px solid ${C.outlineVariant}`, color: C.onSurface, cursor: "pointer", padding: "8px 18px", borderRadius: 8, fontFamily: F.code, fontSize: 12 }}>Cancel</button>
              <button onClick={() => void respawnAndRetry()} disabled={respawning} style={{ background: C.primary, border: "none", color: C.onPrimary, cursor: "pointer", padding: "8px 18px", borderRadius: 8, fontFamily: F.code, fontSize: 12, fontWeight: 700, opacity: respawning ? 0.6 : 1 }}>
                {respawning ? "Provisioning..." : "Respawn & Continue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
