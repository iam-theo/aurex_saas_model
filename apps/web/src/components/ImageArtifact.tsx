import { useState, useEffect, useRef } from "react";
import { api, type Artifact } from "../api";
import { C, F, Icon } from "./project-ui";

interface ImageArtifactProps {
  artifact: Artifact;
  projectId: string;
}

function CircularProgress({ size = 64, strokeWidth = 4 }: { size?: number; strokeWidth?: number }) {
  const [progress, setProgress] = useState(0);
  const startRef = useRef(Date.now());
  const duration = 30000; // 30s cycle

  useEffect(() => {
    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      const p = Math.min((elapsed % duration) / duration, 1);
      setProgress(p);
    };
    const id = setInterval(tick, 50);
    return () => clearInterval(id);
  }, []);

  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - progress);

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`${C.primary}20`} strokeWidth={strokeWidth} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={C.primary} strokeWidth={strokeWidth}
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.05s linear" }}
        />
      </svg>
      <div
        style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <Icon name="image" size={20} color={C.primary} />
      </div>
    </div>
  );
}

export function ImageArtifact({ artifact, projectId }: ImageArtifactProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const isComplete = artifact.status === "completed" && artifact.storageKey;
  const isFailed = artifact.status === "failed";

  const imgUrl = isComplete ? api.artifactUrl(projectId, artifact.id) : "";
  const downloadUrl = isComplete ? api.artifactDownloadUrl(projectId, artifact.id) : "";

  // Reset states when artifact changes
  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [artifact.id, artifact.status]);

  return (
    <>
      <div
        style={{
          background: C.surfaceContainerLow,
          border: `1px solid ${C.outlineVariant}`,
          borderRadius: 12,
          overflow: "hidden",
          maxWidth: 512,
        }}
      >
        <div
          style={{
            position: "relative",
            background: C.surfaceContainer,
            minHeight: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Loading: circular progress */}
          {!isComplete && !isFailed && (
            <div style={{ padding: 40, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
              <CircularProgress size={64} strokeWidth={4} />
              <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>Generating image...</span>
            </div>
          )}

          {/* Error */}
          {isFailed && (
            <div style={{ padding: 40, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: `${C.error}20`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name="error" size={18} color={C.error} />
              </div>
              <span style={{ fontFamily: F.code, fontSize: 11, color: C.error }}>Failed to generate image</span>
            </div>
          )}

          {/* Image */}
          {isComplete && (
            <img
              src={imgUrl}
              alt={artifact.filename}
              onLoad={() => setLoaded(true)}
              onError={() => setError(true)}
              style={{
                display: loaded ? "block" : "none",
                width: "100%",
                height: "auto",
                maxHeight: 400,
                objectFit: "contain",
              }}
            />
          )}

          {/* Fallback while image loads */}
          {isComplete && !loaded && !error && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CircularProgress size={40} strokeWidth={3} />
            </div>
          )}
        </div>

        {/* Info bar with download */}
        <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.outlineVariant}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <Icon name="image" size={14} color={C.onSurfaceVariant} />
            <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {isComplete ? artifact.filename : "generating..."}
            </span>
            {artifact.width && artifact.height && isComplete && (
              <span style={{ fontFamily: F.code, fontSize: 10, color: C.outline, flexShrink: 0 }}>
                {artifact.width}x{artifact.height}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {isComplete && (
              <button
                onClick={() => setPreviewOpen(true)}
                title="Open preview"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 28, height: 28, borderRadius: 6,
                  background: "transparent", border: `1px solid ${C.outlineVariant}`,
                  color: C.onSurfaceVariant, cursor: "pointer", transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceContainerHigh; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <Icon name="open_in_full" size={14} color="currentColor" />
              </button>
            )}
            {isComplete && (
              <a
                href={downloadUrl}
                download={artifact.filename}
                title="Download"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 28, height: 28, borderRadius: 6,
                  background: "transparent", border: `1px solid ${C.outlineVariant}`,
                  color: C.onSurfaceVariant, cursor: "pointer", transition: "all 0.15s",
                  textDecoration: "none",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceContainerHigh; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <Icon name="download" size={14} color="currentColor" />
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Preview modal */}
      {previewOpen && isComplete && (
        <div
          onClick={() => setPreviewOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 32, cursor: "zoom-out",
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ position: "relative", maxWidth: "90vw", maxHeight: "90vh" }}>
            <img
              src={imgUrl}
              alt={artifact.filename}
              style={{ maxWidth: "100%", maxHeight: "85vh", objectFit: "contain", borderRadius: 8 }}
            />
            <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 8 }}>
              <a
                href={downloadUrl}
                download={artifact.filename}
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 36, height: 36, borderRadius: 8,
                  background: "rgba(0,0,0,0.6)", border: "none",
                  color: "#fff", cursor: "pointer", textDecoration: "none",
                }}
              >
                <Icon name="download" size={18} color="currentColor" />
              </a>
              <button
                onClick={() => setPreviewOpen(false)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 36, height: 36, borderRadius: 8,
                  background: "rgba(0,0,0,0.6)", border: "none",
                  color: "#fff", cursor: "pointer",
                }}
              >
                <Icon name="close" size={18} color="currentColor" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
