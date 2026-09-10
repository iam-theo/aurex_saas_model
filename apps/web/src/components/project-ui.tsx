import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSidebar } from "../hooks/useSidebar";

// --- Material 3 dark theme tokens (mirrors reference Tailwind config) -------

export const C = {
  primary: "#4edea3",
  onPrimary: "#003824",
  primaryContainer: "#10b981",
  onPrimaryContainer: "#00422b",
  secondary: "#c0c1ff",
  secondaryContainer: "#3131c0",
  onSecondaryContainer: "#b0b2ff",
  tertiary: "#ffafd3",
  tertiaryContainer: "#f876ba",
  onTertiaryContainer: "#72004b",
  background: "#0e1511",
  onBackground: "#dde4dd",
  surface: "#0e1511",
  surfaceBright: "#343b36",
  surfaceContainerLowest: "#09100c",
  surfaceContainerLow: "#161d19",
  surfaceContainer: "#1a211d",
  surfaceContainerHigh: "#242c27",
  surfaceContainerHighest: "#2f3632",
  surfaceVariant: "#2f3632",
  onSurface: "#dde4dd",
  onSurfaceVariant: "#bbcabf",
  outline: "#86948a",
  outlineVariant: "#3c4a42",
  error: "#ffb4ab",
  onErrorContainer: "#ffdad6",
} as const;

export const F = {
  display: `"Geist", "Inter", sans-serif`,
  body: `"Geist", "Inter", sans-serif`,
  code: `"JetBrains Mono", monospace`,
} as const;

export const GAP = 8;
export const PAD = 16;

// --- shared layout primitives ----------------------------------------------

export function Icon({
  name,
  size,
  color,
  fill,
}: {
  name: string;
  size?: number;
  color?: string;
  fill?: boolean;
}) {
  return (
    <span
      className="material-symbols-outlined"
      style={{
        fontSize: size ?? 18,
        color,
        lineHeight: 1,
        fontVariationSettings: fill ? `'FILL' 1, 'wght' 400` : `'FILL' 0, 'wght' 400`,
      }}
    >
      {name}
    </span>
  );
}

export function Avatar({
  src,
  name,
  agent,
}: {
  src?: string | null;
  name?: string | null;
  agent?: boolean;
}) {
  const initials = (name ?? "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  if (agent) {
    return (
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: C.secondaryContainer,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: C.onSecondaryContainer,
          fontWeight: 700,
          fontSize: 16,
          boxShadow: "0 0 8px rgba(49,49,192,0.3)",
        }}
      >
        A
      </div>
    );
  }
  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        flexShrink: 0,
        overflow: "hidden",
        border: `1px solid ${C.outlineVariant}`,
        background: C.surfaceContainerHighest,
      }}
    >
      {src ? (
        <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 700,
            color: C.onSurfaceVariant,
          }}
        >
          {initials}
        </div>
      )}
    </div>
  );
}

// --- project sidebar --------------------------------------------------------

export type SidebarTab = "chat" | "files" | "env" | "github" | "model" | "delete";

export function Sidebar({
  projectId,
  active,
  chatHref,
  onLogout,
  open,
  onToggle,
}: {
  projectId: string;
  active: SidebarTab;
  chatHref?: string;
  onLogout: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const items: Array<{ key: SidebarTab; icon: string; label: string; to: string }> = [
    { key: "chat", icon: "chat", label: "Chat", to: chatHref ?? `/projects/${projectId}` },
    { key: "files", icon: "code", label: "File Editor", to: `/projects/${projectId}/files` },
    { key: "env", icon: "assignment", label: "Environment Variables", to: `/projects/${projectId}/env` },
    { key: "github", icon: "hub", label: "Github", to: `/projects/${projectId}/github` },
    { key: "model", icon: "robot", label: "Model", to: `/projects/${projectId}/model` },
    { key: "delete", icon: "delete", label: "Delete App", to: `/projects/${projectId}/delete` },
  ];
  return (
    <nav
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: open ? `${PAD}px 0` : "12px 0",
        gap: GAP,
        background: C.surfaceContainerLow,
        borderRight: `1px solid ${C.outlineVariant}`,
        width: open ? 256 : 56,
        minWidth: open ? 256 : 56,
        flexShrink: 0,
        position: "relative",
        zIndex: 20,
        overflow: "hidden",
        transition: "width 0.2s ease, min-width 0.2s ease, padding 0.2s ease",
      }}
    >
      {/* Toggle button */}
      <div style={{ padding: `0 ${PAD}px`, marginBottom: open ? 24 : 12, display: "flex", justifyContent: open ? "flex-end" : "center" }}>
        <button onClick={onToggle} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 8, background: "transparent", border: `1px solid ${C.outlineVariant}`, color: C.onSurfaceVariant, cursor: "pointer", transition: "background 0.15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceContainerHigh; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          <Icon name={open ? "menu_open" : "menu"} size={18} color="currentColor" />
        </button>
      </div>

      {open ? (
        <>
          <div style={{ padding: `0 ${PAD}px`, marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: C.primary,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span style={{ fontFamily: F.display, fontSize: 14, fontWeight: 800, color: "#000" }}>A</span>
              </div>
              <div style={{ fontFamily: F.display, fontSize: 15, fontWeight: 700, color: C.onSurface, lineHeight: 1.2 }}>
                Aurex
              </div>
            </div>
          </div>

          <div style={{ padding: `0 ${PAD}px`, marginBottom: 24 }}>
            <Link
              to={`/projects/${projectId}?publish=1`}
              style={{
                display: "flex",
                width: "100%",
                background: C.primary,
                color: "#000",
                fontFamily: F.code,
                fontSize: 11,
                fontWeight: 700,
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${C.primary}`,
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                textDecoration: "none",
                transition: "opacity 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              <Icon name="rocket_launch" size={15} color="#000" />
              Publish App
            </Link>
          </div>

          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, padding: "0 12px", overflowY: "auto" }}>
            <Link
              to="/dashboard"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 12px",
                marginBottom: 8,
                color: C.onSurfaceVariant,
                borderRadius: 8,
                textDecoration: "none",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = C.onSurface;
                e.currentTarget.style.background = C.surfaceContainerHigh;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = C.onSurfaceVariant;
                e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon name="grid_view" size={18} color="currentColor" />
              <span style={{ fontFamily: F.code, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                Dashboard
              </span>
            </Link>
            {items.map((item) =>
              item.key === active ? (
                <div
                  key={item.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 12px",
                    background: C.secondaryContainer,
                    color: C.onSecondaryContainer,
                    borderRadius: 8,
                    fontWeight: 700,
                  }}
                >
                  <Icon name={item.icon} size={18} color={C.onSecondaryContainer} fill />
                  <span style={{ fontFamily: F.code, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                    {item.label}
                  </span>
                </div>
              ) : (
                <Link
                  key={item.key}
                  to={item.to}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 12px",
                    color: C.onSurfaceVariant,
                    borderRadius: 8,
                    textDecoration: "none",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = C.onSurface;
                    e.currentTarget.style.background = C.surfaceContainerHigh;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = C.onSurfaceVariant;
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <Icon name={item.icon} size={18} color="currentColor" />
                  <span style={{ fontFamily: F.code, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                    {item.label}
                  </span>
                </Link>
              ),
            )}
          </div>

          <button
            onClick={onLogout}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 12px",
              margin: "0 12px",
              color: C.onSurfaceVariant,
              background: "transparent",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              fontFamily: F.code,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              textAlign: "left",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = C.onSurface;
              e.currentTarget.style.background = C.surfaceContainerHigh;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = C.onSurfaceVariant;
              e.currentTarget.style.background = "transparent";
            }}
          >
            <Icon name="logout" size={18} color="currentColor" />
            Logout
          </button>
        </>
      ) : (
        /* Collapsed: icon-only nav */
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "0 4px", overflowY: "auto" }}>
          <Link to={`/projects/${projectId}?publish=1`} title="Publish App" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 8, background: C.primary, border: "none", color: "#000", textDecoration: "none" }}>
            <Icon name="rocket_launch" size={18} color="#000" />
          </Link>
          <Link to="/dashboard" title="Dashboard" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 8, background: "transparent", border: "none", color: C.onSurfaceVariant, textDecoration: "none" }}>
            <Icon name="grid_view" size={18} color="currentColor" />
          </Link>
          {items.map((item) => (
            <Link
              key={item.key}
              to={item.to}
              title={item.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: 8,
                background: item.key === active ? C.surfaceContainerHigh : "transparent",
                border: "none",
                color: item.key === active ? C.primary : C.onSurfaceVariant,
                textDecoration: "none",
              }}
            >
              <Icon name={item.icon} size={18} color="currentColor" />
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}

// --- project top bar --------------------------------------------------------

export function TopBar({
  projectName,
  status,
  connected,
  avatarUrl,
  userName,
  actions,
  onLogout,
  statusText,
}: {
  projectName: string;
  status: string;
  connected: boolean;
  avatarUrl?: string | null;
  userName?: string | null;
  actions?: React.ReactNode;
  onLogout?: () => void;
  statusText?: string;
}) {
  const running = status === "queued" || status === "running";
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!avatarOpen) return;
    const close = (e: MouseEvent) => {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) setAvatarOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [avatarOpen]);

  const displayStatus = statusText || (running ? "working..." : status);

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `0 ${PAD}px`,
        height: 64,
        width: "100%",
        background: C.surface,
        borderBottom: `1px solid ${C.outlineVariant}`,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontFamily: F.display, fontSize: 16, fontWeight: 600, color: C.onSurface }}>
          {projectName}
        </span>
        {status && (
          <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>
            {displayStatus}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {actions}
        <button
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: C.onSurfaceVariant,
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.surfaceVariant)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Icon name="notifications" size={20} color="currentColor" />
        </button>
        <div ref={avatarRef} style={{ position: "relative", marginLeft: 8 }}>
          <button
            onClick={() => setAvatarOpen((o) => !o)}
            style={{ display: "flex", alignItems: "center", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
          >
            <Avatar src={avatarUrl} name={userName} />
          </button>
          {avatarOpen && (
            <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 8, width: 240, background: C.surfaceContainerHigh, border: `1px solid ${C.outlineVariant}`, borderRadius: 10, padding: 14, zIndex: 50, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <Avatar src={avatarUrl} name={userName} />
                <div>
                  <div style={{ fontFamily: F.display, fontSize: 13, fontWeight: 600, color: C.onSurface }}>{userName ?? "User"}</div>
                  <div style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>Signed in</div>
                </div>
              </div>
              {onLogout && (
                <button
                  onClick={() => { setAvatarOpen(false); onLogout(); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.outlineVariant}`, background: "transparent", color: C.error, fontFamily: F.code, fontSize: 12, cursor: "pointer", transition: "background 0.15s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = `${C.error}12`; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <Icon name="logout" size={14} color="currentColor" />
                  Sign out
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// Full-screen shell used by project-context pages (run, env vars, github).
export function ProjectShell({
  projectId,
  active,
  chatHref,
  onLogout,
  topBar,
  children,
}: {
  projectId: string;
  active: SidebarTab;
  chatHref?: string;
  onLogout: () => void;
  topBar: React.ReactNode;
  children: React.ReactNode;
}) {
  const { open, toggle } = useSidebar();
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        width: "100%",
        overflow: "hidden",
        background: C.background,
        color: C.onBackground,
        fontFamily: F.body,
        fontSize: 14,
        lineHeight: 1.6,
      }}
    >
      <Sidebar projectId={projectId} active={active} chatHref={chatHref} onLogout={onLogout} open={open} onToggle={toggle} />
      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          background: C.surface,
          position: "relative",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        {topBar}
        {children}
      </main>
    </div>
  );
}
