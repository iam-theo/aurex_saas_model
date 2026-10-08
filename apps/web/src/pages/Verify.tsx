import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { api } from "../api";

export default function Verify() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const token = params.get("token") ?? "";
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        if (!cancelled) {
          setStatus("error");
          setMessage("Missing verification token.");
        }
        return;
      }
      try {
        await api.verifyEmail(token);
        await refresh();
        if (!cancelled) {
          setStatus("done");
          setTimeout(() => navigate("/dashboard", { replace: true }), 1200);
        }
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setMessage((e as { message: string }).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, navigate, refresh]);

  return (
    <div className="login-wrap">
      <div className="login-shell">
        <div className="login-hero">
          <span className="brand">
            <span className="brand-mark">A</span>
            <span>Aurex</span>
          </span>
          <h1 className="hero-title">
            Email
            <br />
            <span className="grad">verification.</span>
          </h1>
        </div>
        <div className="login-panel">
          {status === "working" && (
            <>
              <h2>Verifying your email…</h2>
              <p className="lead">Please wait a moment.</p>
            </>
          )}
          {status === "done" && (
            <>
              <h2>Email verified</h2>
              <p className="lead">Your account is ready. Taking you to your dashboard…</p>
            </>
          )}
          {status === "error" && (
            <>
              <h2>Verification failed</h2>
              {message && <p className="form-error">{message}</p>}
              <Link to="/login" className="btn btn-primary btn-block">
                Back to sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}