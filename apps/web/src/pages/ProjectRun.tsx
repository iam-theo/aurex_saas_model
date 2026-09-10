import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, displayModel, type Attachment, type ModelInfo, type Project, type Run } from "../api";
import { DEFAULT_VISION_MODEL } from "@aurex/shared/attachments";
import { useAuth } from "../auth";
import { C, F, GAP, PAD, Icon, ProjectShell, TopBar } from "../components/project-ui";
import { getPreferredModel, setPreferredModel } from "../modelPref";

const ARCHITECT_GUIDANCE_PROJECT = [
  "",
  "⛔ If this next piece of work involves a NEW feature, product direction, or architectural choice, follow the MANDATORY DISCOVERY PROTOCOL first:",
  "Before writing code, call the `question` tool with 3-6 enterprise questions (scope, stack with ⭐ recommendation first, auth/roles, data model, integrations, scale/security). Wait for answers, then synthesize a short Build Plan before building. Do NOT present choices as markdown lists — use the `question` tool.",
].join("\n");

const CONTINUE_TEMPLATE = (latestStatus: string, next: string) =>
  [
    "Continue this project from where the previous session left off.",
    "",
    `Previous session status: ${latestStatus}.`,
    "",
    "1. Read ./STATE.md in the project root first — the previous session maintains it with what has been built, the architecture, and what remains.",
    "2. Inspect the existing files and run history to confirm the state before changing anything.",
    "3. Then continue the work:",
    next || "- Finish the remaining planned features and fix any outstanding issues.",
  ].join("\n");

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

function runDuration(r: Run): string | null {
  if (!r.startedAt) return null;
  const end = r.completedAt ? Date.parse(r.completedAt) : Date.now();
  const secs = Math.max(0, Math.round((end - Date.parse(r.startedAt)) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

const statusColor = (s: string): string => {
  if (s === "completed") return C.primary;
  if (s === "running" || s === "queued") return C.secondary;
  if (s === "failed" || s === "cancelled" || s === "timeout") return C.error;
  return C.outline;
};

type PublishView = "idle" | "configure" | "publishing" | "success" | "no_changes";

export default function ProjectRun() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [searchParams] = useSearchParams();
  const isNew = searchParams.get("new") === "1";
  const isPublish = searchParams.get("publish") === "1";

  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [task, setTask] = useState("");
  const [model, setModel] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Publish flow state
  const [publishView, setPublishView] = useState<PublishView>("idle");
  const [subdomain, setSubdomain] = useState("");
  const [subdomainCheck, setSubdomainCheck] = useState<{ checking: boolean; available: boolean | null; slug?: string; reason?: string }>({ checking: false, available: null });
  const [publishDomain, setPublishDomain] = useState<string>((import.meta as unknown as { env?: Record<string,string> }).env?.VITE_PUBLISH_DOMAIN ?? "example.com" );
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null);
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishMsg, setUnpublishMsg] = useState<string | null>(null);
  const subdomainTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pollTimerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!projectId) return;
    api
      .getProject(projectId)
      .then(setProject)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api.listModels().then((ms) => {
      setModels(ms);
      const pref = getPreferredModel(projectId);
      const def = ms.find((m) => m.id === pref)?.id ?? ms.find((m) => m.isDefault)?.id ?? ms[0]?.id ?? "";
      setModel(def);
    });
    api.getConfig().then((c) => { if (c.publishDomain) setPublishDomain(c.publishDomain); }).catch(() => {});
  }, [projectId]);

  // Auto-open publish view when ?publish=1 is in the URL.
  useEffect(() => {
    if (isPublish && project && publishView === "idle") {
      openPublish();
    }
  }, [isPublish, project]);

  // Cleanup poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const runs: Run[] = (project?.runs ?? []) as Run[];
  const latest = runs[0];

  if (!project) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.background }}>
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
    );
  }

  if (latest && !isNew && !isPublish) {
    return <Navigate to={`/runs/${latest.id}`} replace />;
  }

  const start = async () => {
    if (!projectId || !task.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const fullTask = task.trim().includes("DISCOVERY PROTOCOL") ? task.trim() : `${task.trim()}${ARCHITECT_GUIDANCE_PROJECT}`;
      const run = await api.createRun(projectId, fullTask, model || undefined, attachments.map((a) => a.id));
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  const continueLatest = async () => {
    if (!projectId || !latest || starting) return;
    setStarting(true);
    setError(null);
    try {
      const base = CONTINUE_TEMPLATE(latest.status, task.trim());
      const fullTask = `${base}${ARCHITECT_GUIDANCE_PROJECT}`;
      const run = await api.createRun(projectId, fullTask, model || undefined, attachments.map((a) => a.id));
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !projectId || uploading) return;
    setUploading(true);
    setAttachError(null);
    let uploaded: Attachment[] = [];
    try {
      for (const file of Array.from(files)) {
        const res = await api.uploadAttachment(projectId, file);
        uploaded = [...uploaded, res.attachment];
      }
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
    if (uploaded.length === 0) return;
    const hasImage = uploaded.some((a) => a.modality === "image");
    const current = models.find((m) => m.id === model);
    if (hasImage && !current?.image) {
      const visionId = models.find((m) => m.id === DEFAULT_VISION_MODEL)?.id ?? models.find((m) => m.image)?.id;
      if (visionId) {
        setModel(visionId);
        setPreferredModel(projectId, visionId);
      }
    }
  };

  // --- Publish flow ---

  const openPublish = () => {
    setPublishError(null);
    setPublishedUrl(null);

    // Already published — skip configure, go straight to republish (change detection happens server-side).
    if (project.publishedUrl && project.subdomain) {
      setPublishView("publishing");
      void doPublish(true);
      return;
    }

    // First publish — show subdomain config.
    setSubdomain(project.subdomain ?? slugify(project.name));
    setSubdomainCheck({ checking: false, available: null });
    setPublishView("configure");
  };

  const checkSubdomainAvailability = (value: string) => {
    setSubdomain(value);
    if (subdomainTimerRef.current) clearTimeout(subdomainTimerRef.current);
    if (!value || value.length < 2) {
      setSubdomainCheck({ checking: false, available: null });
      return;
    }
    setSubdomainCheck((s) => ({ ...s, checking: true }));
    subdomainTimerRef.current = setTimeout(async () => {
      try {
        const res = await api.checkSubdomain(value, projectId);
        setSubdomainCheck({ checking: false, available: res.available, slug: res.slug, reason: res.reason });
      } catch {
        setSubdomainCheck({ checking: false, available: null });
      }
    }, 400);
  };

  const doPublish = async (forceRepublish = false) => {
    if (!projectId) return;
    if (!forceRepublish && publishView === "configure" && !subdomainCheck.available) return;
    setPublishView("publishing");
    setPublishError(null);
    // clear any prior poll
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    // Helper: transient DNS/Cloudflare/5xx errors should keep spinning, not show error.
    const isTransientError = (msg: string) =>
      msg.includes("DNS did not resolve") ||
      msg.includes("URL returned status") ||
      msg.includes("URL not reachable") ||
      msg.includes("502") ||
      msg.includes("520") ||
      msg.includes("521") ||
      msg.includes("522") ||
      msg.includes("523") ||
      msg.includes("524") ||
      msg.includes("530") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("timeout") ||
      msg.includes("nginx helper");

    api.publishProject(projectId, subdomainCheck.slug ?? subdomain).then(
      (res) => {
        // Don't show URL until poll confirms DNS reachable (publishStatus === done).
        // If backend already verified (most cases), poll will immediately succeed and show success.
        // Otherwise keep spinning and let poll handle the transition.
        void api.getProject(projectId).then((p) => {
          setProject(p);
          if (p.publishStatus === "done" && p.publishedUrl) {
            setPublishedUrl(p.publishedUrl);
            setPublishView("success");
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          } else if (res.url) {
            // fallback: if backend returned URL but status not yet done, keep polling
            // (verify step still in progress on server)
          }
        });
      },
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "no_changes") {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setPublishView("no_changes");
        } else if (isTransientError(msg)) {
          // Keep spinning — DNS/tunnel propagation. Poll will handle success.
          // Don't show error; keep publishView as publishing so user sees spinner + "Verifying DNS…"
          console.warn("[publish] transient, keep polling:", msg);
        } else {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setPublishError(msg);
          setPublishView("configure");
        }
      },
    );

    // Poll project for real-time progress. Keep spinning until done, never surface 502.
    pollTimerRef.current = setInterval(async () => {
      try {
        const p = await api.getProject(projectId!);
        setProject(p);
        if (p.publishStatus === "done" && p.publishedUrl) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setPublishedUrl(p.publishedUrl);
          setPublishView("success");
        } else if (p.publishStatus == null && p.publishProgress == null) {
          // Hard error cleared by backend — stop polling and show config if not already success
          // (transient errors keep status at Verifying DNS, so this won't trigger for them)
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        }
      } catch {
        // ignore poll errors — keep spinning
      }
    }, 1500);
  };

  const copyUrl = (url: string) => {
    void navigator.clipboard.writeText(url);
  };

  const shareUrl = (url: string) => {
    if (navigator.share) {
      void navigator.share({ title: project.name, url });
    } else {
      copyUrl(url);
    }
  };

  const del = async () => {
    if (!projectId || deleting) return;
    if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.deleteProject(projectId);
      navigate("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  const doRollback = async () => {
    if (!projectId || rollingBack) return;
    setRollingBack(true);
    setRollbackMsg(null);
    try {
      const res = await api.rollbackPublish(projectId);
      setRollbackMsg(res.ok ? `Restored from ${res.backup}` : "No backup available");
      // Refresh project state.
      void api.getProject(projectId).then(setProject);
    } catch (e) {
      setRollbackMsg(e instanceof Error ? e.message : "Rollback failed");
    } finally {
      setRollingBack(false);
    }
  };

  const doUnpublish = async () => {
    if (!projectId || unpublishing) return;
    if (!window.confirm(`Unpublish "${project.name}"? This will take down ${project.publishedUrl} and stop its backend. You can Publish again to restart.`)) return;
    setUnpublishing(true);
    setUnpublishMsg(null);
    try {
      await api.unpublishProject(projectId);
      setUnpublishMsg("Unpublished — URL is now down. Publish again to restart.");
      setPublishView("idle");
      setPublishedUrl(null);
      void api.getProject(projectId).then(setProject);
      // clear any polling
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    } catch (e) {
      setUnpublishMsg(e instanceof Error ? e.message : "Unpublish failed");
    } finally {
      setUnpublishing(false);
    }
  };

  const userName = user?.name ?? user?.email ?? "User";

  return (
    <ProjectShell
      projectId={projectId ?? ""}
      active="chat"
      chatHref={`/projects/${projectId}`}
      onLogout={() => void logout().then(() => navigate("/"))}
      topBar={
        <TopBar projectName={project.name} status={latest?.status ?? "idle"} connected={false} avatarUrl={user?.avatarUrl} userName={userName} onLogout={() => void logout().then(() => navigate("/"))} />
      }
    >
      {publishView === "idle" ? (
        /* ---- Normal project view ---- */
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }} className="aurex-scroll">
          <div style={{ width: "100%" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 28 }}>
              <div>
                <h1 style={{ fontFamily: F.display, fontSize: 24, fontWeight: 800, color: C.onSurface, margin: 0 }}>{project.name}</h1>
                <p style={{ fontFamily: F.body, fontSize: 13, color: C.onSurfaceVariant, margin: "6px 0 0" }}>
                  {project.description || "Build apps with an autonomous AI agent. Runs execute in an isolated workspace, streamed live."}
                </p>
                {project.publishedUrl && (
                  <a
                    href={project.publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, fontFamily: F.code, fontSize: 12, color: C.primary, textDecoration: "none" }}
                  >
                    <Icon name="open_in_new" size={14} color={C.primary} />
                    {project.publishedUrl}
                  </a>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
                {project.publishedUrl && (
                  <>
                    <button
                      onClick={() => void doUnpublish()}
                      disabled={unpublishing}
                      title="Unpublish — take down URL"
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "8px 12px", borderRadius: 8,
                        border: `1px solid ${C.error}60`, background: "transparent",
                        color: C.error, fontFamily: F.code, fontSize: 12,
                        cursor: unpublishing ? "default" : "pointer",
                        opacity: unpublishing ? 0.6 : 1,
                      }}
                    >
                      <Icon name="cloud_off" size={15} color="currentColor" />
                      {unpublishing ? "Unpublishing…" : "Unpublish"}
                    </button>
                    <button
                      onClick={() => void doRollback()}
                      disabled={rollingBack}
                      title="Rollback to previous version"
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "8px 12px", borderRadius: 8,
                        border: `1px solid ${C.outlineVariant}`, background: "transparent",
                        color: C.onSurface, fontFamily: F.code, fontSize: 12,
                        cursor: rollingBack ? "default" : "pointer",
                        opacity: rollingBack ? 0.6 : 1,
                      }}
                    >
                      <Icon name="history" size={15} color="currentColor" />
                      {rollingBack ? "Restoring\u2026" : "Rollback"}
                    </button>
                  </>
                )}
                <button
                  onClick={openPublish}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 16px",
                    borderRadius: 8,
                    border: `1px solid ${C.primary}`,
                    background: C.primary,
                    color: "#000",
                    fontFamily: F.code,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  <Icon name="rocket_launch" size={15} color="#000" />
                  {project.publishedUrl ? "Republish" : "Publish"}
                </button>
                <button
                  onClick={() => void del()}
                  disabled={deleting}
                  title="Delete project"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    border: `1px solid ${C.outlineVariant}`,
                    background: C.surfaceContainerHigh,
                    color: C.error,
                    cursor: deleting ? "default" : "pointer",
                    opacity: deleting ? 0.6 : 1,
                  }}
                >
                  <Icon name="delete" size={17} color="currentColor" />
                </button>
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
            {unpublishMsg && (
              <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: `${C.primary}14`, border: `1px solid ${C.primary}40`, fontFamily: F.code, fontSize: 12, color: C.primary }}>
                {unpublishMsg}
              </div>
            )}
            {rollbackMsg && (
              <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: `${C.secondaryContainer}40`, border: `1px solid ${C.outlineVariant}`, fontFamily: F.code, fontSize: 12, color: C.onSurface }}>
                {rollbackMsg}
              </div>
            )}

            {runs.length > 0 && (
              <section style={{ marginBottom: 28 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <h2 style={{ fontFamily: F.display, fontSize: 14, fontWeight: 700, color: C.onSurface, margin: 0 }}>Recent runs</h2>
                  <button
                    onClick={() => void continueLatest()}
                    disabled={starting}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 14px",
                      borderRadius: 8,
                      border: `1px solid ${C.secondaryContainer}`,
                      background: `${C.secondaryContainer}1a`,
                      color: C.onSecondaryContainer,
                      fontFamily: F.code,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: starting ? "default" : "pointer",
                      opacity: starting ? 0.6 : 1,
                    }}
                  >
                    <Icon name="play_arrow" size={15} color="currentColor" />
                    {starting ? "Starting…" : "Continue conversation"}
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {runs.slice(0, 6).map((r) => (
                    <Link
                      key={r.id}
                      to={`/runs/${r.id}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 14px",
                        background: C.surfaceContainerLow,
                        border: `1px solid ${C.outlineVariant}`,
                        borderRadius: 8,
                        textDecoration: "none",
                        transition: "all 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = C.outline;
                        e.currentTarget.style.background = C.surfaceContainer;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = C.outlineVariant;
                        e.currentTarget.style.background = C.surfaceContainerLow;
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: statusColor(r.status),
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, width: 110, flexShrink: 0 }}>
                        {displayModel(r.model)}
                      </span>
                      <span style={{ flex: 1, fontFamily: F.body, fontSize: 13, color: C.onSurface, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.task.split("\n")[0]}
                      </span>
                      <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, flexShrink: 0 }}>
                        {runDuration(r) ?? r.status}
                      </span>
                      <Icon name="chevron_right" size={18} color={C.onSurfaceVariant} />
                    </Link>
                  ))}
                </div>
              </section>
            )}

            <section
              style={{
                background: C.surfaceContainerLowest,
                border: `1px solid ${C.outlineVariant}`,
                borderRadius: 12,
                padding: 24,
              }}
            >
              <h2 style={{ fontFamily: F.display, fontSize: 16, fontWeight: 700, color: C.onSurface, margin: "0 0 4px" }}>
                {runs.length > 0 ? "Start a new run" : "Start building"}
              </h2>
              <p style={{ fontFamily: F.body, fontSize: 12, color: C.onSurfaceVariant, margin: "0 0 16px" }}>
                Describe what the agent should do. It works autonomously in the project's workspace and streams every step live.
              </p>

              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="e.g. Build a landing page with React and Tailwind, add a signup form, and deploy it…"
                spellCheck={false}
                style={{
                  width: "100%",
                  minHeight: 96,
                  padding: 14,
                  borderRadius: 8,
                  border: `1px solid ${C.outlineVariant}`,
                  background: C.surfaceContainerLow,
                  color: C.onSurface,
                  fontFamily: F.body,
                  fontSize: 13,
                  lineHeight: 1.6,
                  resize: "vertical",
                  outline: "none",
                }}
                className="aurex-scroll"
              />

              {models.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontFamily: F.code, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onSurfaceVariant, marginBottom: 8 }}>
                    Model
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {models.map((m) => {
                      const selected = m.id === model;
                      return (
                        <button
                          key={m.id}
                          onClick={() => {
                            setModel(m.id);
                            setPreferredModel(projectId ?? "", m.id);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "6px 12px",
                            borderRadius: 999,
                            fontFamily: F.code,
                            fontSize: 11,
                            fontWeight: selected ? 700 : 400,
                            color: selected ? "#000" : C.onSurfaceVariant,
                            background: selected ? C.primary : C.surfaceContainerHigh,
                            border: `1px solid ${selected ? C.primary : C.outlineVariant}`,
                            cursor: "pointer",
                          }}
                        >
                          {m.label ?? displayModel(m.id)}
                          {m.image && <span title="Vision">👁</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    void pickFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: `1px solid ${C.outlineVariant}`,
                    background: C.surfaceContainerHigh,
                    color: C.onSurfaceVariant,
                    fontFamily: F.code,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: uploading ? "default" : "pointer",
                    opacity: uploading ? 0.6 : 1,
                  }}
                >
                  <Icon name="attach_file" size={15} color="currentColor" />
                  {uploading ? "Uploading…" : "Attach files"}
                </button>
                {attachments.map((a) => (
                  <span
                    key={a.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      background: C.surfaceContainerHigh,
                      border: `1px solid ${C.outlineVariant}`,
                      borderRadius: 999,
                      fontFamily: F.code,
                      fontSize: 11,
                      color: C.onSurfaceVariant,
                    }}
                  >
                    {a.modality === "image" ? "🖼" : a.modality === "pdf" ? "📄" : "📝"}
                    {a.name}
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      style={{ background: "none", border: "none", color: C.onSurfaceVariant, cursor: "pointer", padding: 0, display: "flex" }}
                    >
                      <Icon name="close" size={13} color="currentColor" />
                    </button>
                  </span>
                ))}
              </div>

              <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  onClick={() => void start()}
                  disabled={!task.trim() || starting}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "10px 24px",
                    borderRadius: 8,
                    border: `1px solid ${C.primary}`,
                    background: C.primary,
                    color: "#000",
                    fontFamily: F.code,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: !task.trim() || starting ? "default" : "pointer",
                    opacity: !task.trim() || starting ? 0.5 : 1,
                  }}
                >
                  <Icon name="play_arrow" size={17} color="#000" />
                  {starting ? "Starting…" : "Start Run"}
                </button>
                {attachError && <span style={{ fontFamily: F.code, fontSize: 11, color: C.error }}>{attachError}</span>}
              </div>
            </section>
          </div>
        </div>
      ) : publishView === "configure" ? (
        /* ---- Publish: configure subdomain ---- */
        <PublishConfigure
          project={project}
          subdomain={subdomain}
          subdomainCheck={subdomainCheck}
          publishDomain={publishDomain}
          publishError={publishError}
          onSubdomainChange={checkSubdomainAvailability}
          onPublish={() => void doPublish()}
          onBack={() => setPublishView("idle")}
        />
      ) : publishView === "publishing" ? (
        /* ---- Publish: in progress ---- */
        <PublishProgress project={project} />
      ) : publishView === "no_changes" ? (
        /* ---- Publish: no new changes ---- */
        <PublishNoChanges project={project} onBack={() => setPublishView("idle")} onRepublish={() => { setPublishView("publishing"); void doPublish(true); }} />
      ) : (
        /* ---- Publish: success ---- */
        <PublishSuccess
          project={project}
          publishedUrl={publishedUrl!}
          onCopyUrl={copyUrl}
          onShareUrl={shareUrl}
          onDone={() => setPublishView("idle")}
        />
      )}
    </ProjectShell>
  );
}

// --- Publish sub-views -------------------------------------------------------

function PublishConfigure({
  project,
  subdomain,
  subdomainCheck,
  publishDomain,
  publishError,
  onSubdomainChange,
  onPublish,
  onBack,
}: {
  project: Project;
  subdomain: string;
  subdomainCheck: { checking: boolean; available: boolean | null; slug?: string; reason?: string };
  publishDomain: string;
  publishError: string | null;
  onSubdomainChange: (v: string) => void;
  onPublish: () => void;
  onBack: () => void;
}) {
  const slug = subdomain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const RESERVED = ["api", "www", "mail", "admin", "app", "dashboard", "docs", "status", "health", "auth"];
  const isValid = slug.length >= 2 && !RESERVED.includes(slug);
  const canPublish = isValid && subdomainCheck.available === true;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }} className="aurex-scroll">
      <div style={{ width: "100%" }}>
        <button
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            color: C.onSurfaceVariant,
            cursor: "pointer",
            fontFamily: F.code,
            fontSize: 12,
            padding: "4px 0",
            marginBottom: 24,
          }}
        >
          <Icon name="arrow_back" size={16} color="currentColor" />
          Back to project
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: `linear-gradient(135deg, ${C.primaryContainer}, ${C.secondaryContainer})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="rocket_launch" size={24} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontFamily: F.display, fontSize: 22, fontWeight: 800, color: C.onSurface, margin: 0 }}>
              Publish <span style={{ color: C.primary }}>{project.name}</span>
            </h1>
            <p style={{ fontFamily: F.body, fontSize: 13, color: C.onSurfaceVariant, margin: "4px 0 0" }}>
              Choose a subdomain for your live site
            </p>
          </div>
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={{ display: "block", fontFamily: F.code, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: C.onSurfaceVariant, marginBottom: 8 }}>
            Subdomain
          </label>
          <div style={{ display: "flex", alignItems: "center", background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 10, overflow: "hidden" }}>
            <input
              type="text"
              value={subdomain}
              onChange={(e) => onSubdomainChange(e.target.value)}
              spellCheck={false}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                color: C.onSurface,
                fontFamily: F.code,
                fontSize: 15,
                padding: "14px 16px",
                outline: "none",
              }}
            />
            <span style={{ fontFamily: F.code, fontSize: 14, color: C.outline, padding: "0 16px", userSelect: "none", flexShrink: 0 }}>
              .{publishDomain}
            </span>
          </div>

          <div style={{ marginTop: 10, minHeight: 20 }}>
            {subdomainCheck.checking ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
                <span style={{ width: 14, height: 14, border: `2px solid ${C.outlineVariant}`, borderTopColor: C.primary, borderRadius: "50%", animation: "aurex-spin 0.8s linear infinite" }} />
                Checking availability…
              </div>
            ) : subdomainCheck.available === true ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.code, fontSize: 12, color: C.primary }}>
                <Icon name="check_circle" size={16} color={C.primary} fill />
                {subdomainCheck.slug ?? slug}.{publishDomain} is available
              </div>
            ) : subdomainCheck.available === false ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: F.code, fontSize: 12, color: C.error }}>
                <Icon name="error" size={16} color={C.error} fill />
                {subdomainCheck.reason === "reserved"
                  ? "This subdomain is reserved"
                  : subdomainCheck.reason === "too short"
                    ? "Subdomain must be at least 2 characters"
                    : "This subdomain is already taken"}
              </div>
            ) : slug.length >= 2 && isValid ? null : slug.length > 0 ? (
              <div style={{ fontFamily: F.code, fontSize: 12, color: C.outline }}>
                {slug.length < 2 ? "At least 2 characters required" : "Only lowercase letters, numbers, and hyphens"}
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 10, padding: "14px 16px", marginBottom: 32 }}>
          <div style={{ fontFamily: F.code, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: C.outline, marginBottom: 6 }}>
            Preview URL
          </div>
          <div style={{ fontFamily: F.code, fontSize: 14, color: canPublish ? C.primary : C.onSurfaceVariant, wordBreak: "break-all" }}>
            https://{subdomainCheck.slug ?? slug}.{publishDomain}
          </div>
        </div>

        {publishError && (
          <div style={{ marginBottom: 24, padding: "10px 14px", borderRadius: 8, background: `${C.error}15`, border: `1px solid ${C.error}40`, color: C.error, fontFamily: F.code, fontSize: 12 }}>
            {publishError}
          </div>
        )}

        <button
          onClick={onPublish}
          disabled={!canPublish}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            width: "100%",
            padding: "14px 24px",
            borderRadius: 10,
            border: "none",
            background: canPublish ? C.primary : C.surfaceContainerHigh,
            color: canPublish ? C.onPrimary : C.outline,
            fontFamily: F.code,
            fontSize: 14,
            fontWeight: 700,
            cursor: canPublish ? "pointer" : "not-allowed",
            opacity: canPublish ? 1 : 0.5,
            transition: "all 0.2s",
          }}
        >
          <Icon name="rocket_launch" size={18} color={canPublish ? C.onPrimary : C.outline} />
          Publish Now
        </button>
      </div>
    </div>
  );
}

function PublishProgress({ project }: { project: Project }) {
  const progress = project.publishProgress ?? 0;
  const status = project.publishStatus ?? "Preparing…";

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }} className="aurex-scroll">
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ width: 72, height: 72, borderRadius: 18, background: `linear-gradient(135deg, ${C.primaryContainer}, ${C.secondaryContainer})`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 28px", animation: "aurex-pulse 2s ease-in-out infinite" }}>
          <Icon name="rocket_launch" size={36} color="#fff" />
        </div>

        <h2 style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, color: C.onSurface, margin: "0 0 8px" }}>
          Publishing {project.name}
        </h2>
        <p style={{ fontFamily: F.body, fontSize: 14, color: C.onSurfaceVariant, margin: "0 0 32px" }}>
          {status}
        </p>

        <div style={{ width: "100%", height: 6, borderRadius: 3, background: C.surfaceContainerHighest, overflow: "hidden", marginBottom: 12 }}>
          <div
            style={{
              height: "100%",
              borderRadius: 3,
              background: `linear-gradient(90deg, ${C.primaryContainer}, ${C.primary})`,
              width: `${Math.max(progress, 5)}%`,
              transition: "width 0.6s ease",
            }}
          />
        </div>
        <div style={{ fontFamily: F.code, fontSize: 13, fontWeight: 600, color: C.primary }}>
          {progress}%
        </div>

        <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 0 }}>
          {[
            { label: "Building frontend", threshold: 15, icon: "build" },
            { label: "Locating build output", threshold: 35, icon: "folder_open" },
            { label: "Starting backend server", threshold: 45, icon: "dns" },
            { label: "Copying to webroot", threshold: 60, icon: "content_copy" },
            { label: "Configuring nginx", threshold: 75, icon: "settings" },
            { label: "Setting up Cloudflare tunnel", threshold: 85, icon: "cloud" },
            { label: "Creating DNS record", threshold: 92, icon: "lan" },
            { label: "Verifying DNS & waiting for site to go live", threshold: 95, icon: "verified" },
            { label: "Warming up preview (30s)", threshold: 96, icon: "hourglass_empty" },
          ].map((s) => {
            const done = progress >= s.threshold;
            const active = progress >= s.threshold - 15 && progress < s.threshold;
            return (
              <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", opacity: done || active ? 1 : 0.35 }}>
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  background: done ? `${C.primaryContainer}30` : active ? C.surfaceContainerHigh : C.surfaceContainerLow,
                  border: `1px solid ${done ? `${C.primary}40` : C.outlineVariant}`,
                }}>
                  {done ? (
                    <Icon name="check" size={14} color={C.primary} />
                  ) : active ? (
                    <span style={{ width: 10, height: 10, border: `2px solid ${C.outlineVariant}`, borderTopColor: C.primary, borderRadius: "50%", animation: "aurex-spin 0.8s linear infinite", display: "block" }} />
                  ) : (
                    <Icon name={s.icon} size={14} color={C.outline} />
                  )}
                </div>
                <span style={{ fontFamily: F.code, fontSize: 12, color: done ? C.primary : active ? C.onSurface : C.outline, fontWeight: done || active ? 600 : 400 }}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PublishSuccess({
  project,
  publishedUrl,
  onCopyUrl,
  onShareUrl,
  onDone,
}: {
  project: Project;
  publishedUrl: string;
  onCopyUrl: (url: string) => void;
  onShareUrl: (url: string) => void;
  onDone: () => void;
}) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }} className="aurex-scroll">
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{
          background: `linear-gradient(135deg, ${C.primaryContainer}15, ${C.secondaryContainer}15)`,
          border: `1px solid ${C.primary}40`,
          borderRadius: 16,
          padding: "40px 32px",
          marginBottom: 32,
        }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: `${C.primaryContainer}25`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
            <Icon name="check_circle" size={36} color={C.primary} fill />
          </div>
          <h2 style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, color: C.onSurface, margin: "0 0 8px" }}>
            Successfully published!
          </h2>
          <p style={{ fontFamily: F.body, fontSize: 14, color: C.onSurfaceVariant, margin: 0 }}>
            {project.name} is now live on the web
          </p>
        </div>

        <div style={{ background: C.surfaceContainerLow, border: `1px solid ${C.outlineVariant}`, borderRadius: 12, padding: "16px 20px", marginBottom: 24 }}>
          <div style={{ fontFamily: F.code, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: C.outline, marginBottom: 8 }}>
            Live URL
          </div>
          <a
            href={publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontFamily: F.code, fontSize: 16, fontWeight: 600, color: C.primary, textDecoration: "none", wordBreak: "break-all", lineHeight: 1.5 }}
          >
            {publishedUrl}
          </a>
        </div>

        <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 40 }}>
          <a
            href={publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 24px",
              borderRadius: 10,
              background: C.primary,
              color: C.onPrimary,
              fontFamily: F.code,
              fontSize: 13,
              fontWeight: 700,
              textDecoration: "none",
              transition: "box-shadow 0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 0 16px rgba(78,222,163,0.3)")}
            onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "none")}
          >
            <Icon name="open_in_new" size={16} color={C.onPrimary} />
            Preview
          </a>
          <button
            onClick={() => onCopyUrl(publishedUrl)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 24px",
              borderRadius: 10,
              background: C.surfaceContainerHigh,
              border: `1px solid ${C.outlineVariant}`,
              color: C.onSurface,
              fontFamily: F.code,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = C.surfaceContainerHighest;
              e.currentTarget.style.borderColor = C.primary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = C.surfaceContainerHigh;
              e.currentTarget.style.borderColor = C.outlineVariant;
            }}
          >
            <Icon name="content_copy" size={16} color="currentColor" />
            Copy URL
          </button>
          <button
            onClick={() => onShareUrl(publishedUrl)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 24px",
              borderRadius: 10,
              background: C.surfaceContainerHigh,
              border: `1px solid ${C.outlineVariant}`,
              color: C.onSurface,
              fontFamily: F.code,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = C.surfaceContainerHighest;
              e.currentTarget.style.borderColor = C.primary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = C.surfaceContainerHigh;
              e.currentTarget.style.borderColor = C.outlineVariant;
            }}
          >
            <Icon name="share" size={16} color="currentColor" />
            Share
          </button>
        </div>

        <button
          onClick={onDone}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "none",
            border: `1px solid ${C.outlineVariant}`,
            color: C.onSurfaceVariant,
            fontFamily: F.code,
            fontSize: 12,
            padding: "8px 18px",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          <Icon name="arrow_back" size={14} color="currentColor" />
          Back to project
        </button>
      </div>
    </div>
  );
}

function PublishNoChanges({
  project,
  onBack,
  onRepublish,
}: {
  project: Project;
  onBack: () => void;
  onRepublish: () => void;
}) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }} className="aurex-scroll">
      <div style={{ width: "100%", textAlign: "center" }}>
        <div style={{ width: 72, height: 72, borderRadius: 18, background: C.surfaceContainerHigh, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 28px", border: `1px solid ${C.outlineVariant}` }}>
          <Icon name="check" size={36} color={C.primary} />
        </div>

        <h2 style={{ fontFamily: F.display, fontSize: 22, fontWeight: 700, color: C.onSurface, margin: "0 0 8px" }}>
          No new changes to publish
        </h2>
        <p style={{ fontFamily: F.body, fontSize: 14, color: C.onSurfaceVariant, margin: "0 0 12px", lineHeight: 1.5 }}>
          The live version at{" "}
          <a href={project.publishedUrl!} target="_blank" rel="noopener noreferrer" style={{ color: C.primary, textDecoration: "none", fontFamily: F.code, fontSize: 13 }}>
            {project.publishedUrl}
          </a>{" "}
          already matches the latest completed run. Make some changes in a new run first, then come back and publish again.
        </p>

        {project.publishedUrl && (
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 32 }}>
            <a
              href={project.publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 20px",
                borderRadius: 10,
                background: C.surfaceContainerHigh,
                border: `1px solid ${C.outlineVariant}`,
                color: C.onSurface,
                fontFamily: F.code,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              <Icon name="open_in_new" size={15} color="currentColor" />
              View live site
            </a>
          </div>
        )}

        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <button
            onClick={onBack}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "none",
              border: `1px solid ${C.outlineVariant}`,
              color: C.onSurfaceVariant,
              fontFamily: F.code,
              fontSize: 12,
              padding: "8px 18px",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            <Icon name="arrow_back" size={14} color="currentColor" />
            Back to project
          </button>
          <button
            onClick={onRepublish}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "none",
              border: `1px solid ${C.primary}`,
              color: C.primary,
              fontFamily: F.code,
              fontSize: 12,
              padding: "8px 18px",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            <Icon name="refresh" size={14} color="currentColor" />
            Republish anyway
          </button>
        </div>
      </div>
    </div>
  );
}
