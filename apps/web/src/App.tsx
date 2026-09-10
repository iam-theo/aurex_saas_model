import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Routes, Route, Link, NavLink, Navigate, useLocation } from "react-router-dom";
const Dashboard = lazy(() => import("./pages/Dashboard"));
const ProjectRun = lazy(() => import("./pages/ProjectRun"));
const Run = lazy(() => import("./pages/Run"));
const FileManager = lazy(() => import("./pages/FileManager"));
const EnvVars = lazy(() => import("./pages/EnvVars"));
const Github = lazy(() => import("./pages/Github"));
const Models = lazy(() => import("./pages/Models"));
const Login = lazy(() => import("./pages/Login"));
const Landing = lazy(() => import("./pages/Landing"));
const LegalPage = lazy(() => import("./pages/Legal"));
const DeleteApp = lazy(() => import("./pages/DeleteApp"));
const ImportProject = lazy(() => import("./pages/ImportProject"));
import { AuthProvider, useAuth } from "./auth";

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!user) return null;
  const initials = (user.name ?? user.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  return (
    <div className={`user-menu ${open ? "open" : ""}`} ref={ref}>
      <button className="user-chip" onClick={() => setOpen((o) => !o)}>
        {user.avatarUrl ? (
          <img className="topbar-avatar" src={user.avatarUrl} alt="" />
        ) : (
          <span className="avatar-fallback">{initials}</span>
        )}
        <span className="user-meta">
          <span className="user-name">{user.name ?? "Account"}</span>
          <span className="user-email">{user.email}</span>
        </span>
        <span className="chevron">▾</span>
      </button>
      {open && (
        <div className="user-dropdown">
          <div className="dd-label">
            {user.name ? `${user.name} · ` : ""}
            {user.email}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function TopBar() {
  const { authenticated } = useAuth();
  return (
    <header className="topbar">
      <Link to={authenticated ? "/dashboard" : "/"} className="brand">
        <span className="brand-mark">A</span>
        <span>Aurex</span>
        <span className="brand-sub">AI Workforce Platform</span>
      </Link>
      {authenticated && (
        <>
          <nav className="topnav">
            <NavLink to="/dashboard" end className={({ isActive }) => (isActive ? "active" : "")}>
              Dashboard
            </NavLink>
          </nav>
          <UserMenu />
        </>
      )}
    </header>
  );
}

function AppRoutes() {
  const { loading, configured, authenticated } = useAuth();
  const location = useLocation();
  const isLanding = location.pathname === "/";
  const isLegal =
    location.pathname === "/privacy" || location.pathname === "/terms";

  const onPublic =
    isLanding ||
    isLegal ||
    location.pathname === "/login";
  if (configured && !authenticated && !onPublic) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (configured && authenticated && location.pathname === "/login") {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <Suspense fallback={<div style={{ padding: 24, opacity: 0.6 }}>Loading…</div>}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="/terms" element={<LegalPage kind="terms" />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/import" element={<ImportProject />} />
        <Route path="/projects/:projectId" element={<ProjectRun />} />
        <Route path="/projects/:projectId/files" element={<FileManager />} />
        <Route path="/projects/:projectId/env" element={<EnvVars />} />
        <Route path="/projects/:projectId/github" element={<Github />} />
        <Route path="/projects/:projectId/model" element={<Models />} />
        <Route path="/projects/:projectId/delete" element={<DeleteApp />} />
        <Route path="/runs/:runId" element={<Run />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  const location = useLocation();
  const isLanding = location.pathname === "/";
  const isLegal =
    location.pathname === "/privacy" || location.pathname === "/terms";
  const isIde = location.pathname.startsWith("/projects/");
  const isDash = location.pathname === "/dashboard";
  const isRun = location.pathname.startsWith("/runs/");
  const isBare = isLanding || isLegal || isIde || isDash || isRun;
  return (
    <AuthProvider>
      <div className="app">
        {!isBare && <TopBar />}
        <main className={isBare ? "content content--flush" : "content"}>
          <AppRoutes />
        </main>
      </div>
    </AuthProvider>
  );
}
