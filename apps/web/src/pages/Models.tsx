import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, displayModel, type ModelInfo } from "../api";
import { useAuth } from "../auth";
import { C, F, Icon, ProjectShell, TopBar } from "../components/project-ui";
import { getPreferredModel, setPreferredModel } from "../modelPref";

interface ModelCategory {
  label: string;
  description: string;
  icon: string;
}

interface ModelsResponse {
  opencode: ModelInfo[];
  aurextra: ModelInfo[];
  custom: ModelInfo[];
  categories: Record<string, ModelCategory>;
  defaultPerCategory: Record<string, string>;
  autoModelId: string;
}

interface AureXtraModelInfo extends ModelInfo {
  category?: string;
  contextLength?: number;
  modality?: string;
  description?: string;
}

const CATEGORY_ORDER = ["coding", "reasoning", "multimodal", "rag", "safety", "audio", "lightweight"];

export default function Models() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [projectName, setProjectName] = useState("");
  const [modelsData, setModelsData] = useState<ModelsResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"aurextra" | "opencode">("aurextra");
  const [activeCategory, setActiveCategory] = useState<string>("coding");

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then((p) => setProjectName(p.name)).catch(() => undefined);
    api
      .listModels()
      .then((data: unknown) => {
        const res = data as ModelsResponse;
        setModelsData(res);
        const pref = getPreferredModel(projectId);
        setSelected(pref ?? res.autoModelId ?? res.aurextra[0]?.id ?? null);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [projectId]);

  const choose = (id: string) => {
    setSelected(id);
    if (projectId) setPreferredModel(projectId, id);
  };

  const userName = user?.name ?? user?.email ?? "User";
  const allModels = modelsData
    ? [...modelsData.opencode, ...modelsData.aurextra, ...modelsData.custom]
    : [];
  const selectedModel = allModels.find((m) => m.id === selected);

  const aurextraByCategory: Record<string, AureXtraModelInfo[]> = {};
  if (modelsData?.aurextra) {
    for (const model of modelsData.aurextra) {
      const m = model as AureXtraModelInfo;
      const cat = m.category || "coding";
      if (!aurextraByCategory[cat]) aurextraByCategory[cat] = [];
      aurextraByCategory[cat].push(m);
    }
  }

  const categories = modelsData?.categories || {};
  const autoModelId = modelsData?.autoModelId || "aurextra/auto";

  return (
    <ProjectShell
      projectId={projectId ?? ""}
      active="model"
      chatHref={`/projects/${projectId}`}
      onLogout={() => void logout().then(() => navigate("/"))}
      topBar={
        <TopBar projectName={projectName || "—"} status="model" connected={false} avatarUrl={user?.avatarUrl} userName={userName} onLogout={() => void logout().then(() => navigate("/"))} />
      }
    >
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px", display: "flex", flexDirection: "column", gap: 24 }} className="aurex-scroll">
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
            <div>
              <h1 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 700, color: C.onSurface, margin: 0 }}>Choose Model</h1>
              <p style={{ fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant, margin: "4px 0 0" }}>
                Select a model for your project. Auto mode picks the best model per task.
              </p>
            </div>
            {selectedModel && (
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: `${C.primary}14`,
                  border: `1px solid ${C.primary}50`,
                  color: C.primary,
                  fontFamily: F.code,
                  fontSize: 11,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                <Icon name="check_circle" size={14} color="currentColor" />
                {selected === autoModelId ? "Auto (Intelligent)" : (selectedModel.label ?? displayModel(selectedModel.id))}
              </span>
            )}
          </div>

          {/* Error */}
          {error && (
            <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: `${C.error}14`, border: `1px solid ${C.error}40`, fontFamily: F.code, fontSize: 12, color: C.error }}>
              {error}
            </div>
          )}

          {/* Provider Tabs */}
          <div style={{ display: "flex", gap: 8, marginBottom: 20, borderBottom: `1px solid ${C.outlineVariant}`, paddingBottom: 8 }}>
            <button
              onClick={() => setActiveTab("aurextra")}
              style={{
                padding: "8px 16px", borderRadius: 8,
                background: activeTab === "aurextra" ? C.primaryContainer : "transparent",
                color: activeTab === "aurextra" ? C.onPrimaryContainer : C.onSurfaceVariant,
                border: `1px solid ${activeTab === "aurextra" ? C.primary : C.outlineVariant}`,
                fontFamily: F.code, fontSize: 12, fontWeight: activeTab === "aurextra" ? 700 : 400, cursor: "pointer",
              }}
            >
              AureXtra Models
            </button>
            <button
              onClick={() => setActiveTab("opencode")}
              style={{
                padding: "8px 16px", borderRadius: 8,
                background: activeTab === "opencode" ? C.primaryContainer : "transparent",
                color: activeTab === "opencode" ? C.onPrimaryContainer : C.onSurfaceVariant,
                border: `1px solid ${activeTab === "opencode" ? C.primary : C.outlineVariant}`,
                fontFamily: F.code, fontSize: 12, fontWeight: activeTab === "opencode" ? 700 : 400, cursor: "pointer",
              }}
            >
              Aurex Models
            </button>
          </div>

          {loading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: F.code, fontSize: 13, color: C.onSurfaceVariant }}>
              <span style={{ width: 16, height: 16, borderRadius: 999, border: `2px solid ${C.outlineVariant}`, borderTopColor: C.primary, animation: "aurex-spin 0.8s linear infinite" }} />
              Loading models...
            </div>
          ) : (
            <>
              {/* ─── AureXtra Tab ─── */}
              {activeTab === "aurextra" && modelsData && (
                <div>
                  {/* Auto-Select Card */}
                  <button
                    onClick={() => choose(autoModelId)}
                    style={{
                      width: "100%", textAlign: "left", padding: "16px 18px", borderRadius: 12, marginBottom: 16,
                      background: selected === autoModelId ? `linear-gradient(135deg, ${C.primaryContainer}30, ${C.secondaryContainer}30)` : C.surfaceContainerLow,
                      border: `2px solid ${selected === autoModelId ? C.primary : C.outlineVariant}`,
                      color: C.onSurface, cursor: "pointer", transition: "all 0.15s",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div
                        style={{
                          width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center",
                          background: selected === autoModelId ? C.primary : C.secondaryContainer,
                          color: selected === autoModelId ? "#000" : C.onSecondaryContainer,
                        }}
                      >
                        <Icon name="auto_awesome" size={20} color="currentColor" />
                      </div>
                      <div>
                        <div style={{ fontFamily: F.display, fontSize: 15, fontWeight: 700, color: selected === autoModelId ? C.primary : C.onSurface }}>
                          Auto Select
                        </div>
                        <div style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>
                          Aurex picks the best model for each task automatically
                        </div>
                      </div>
                      {selected === autoModelId && (
                        <span style={{ marginLeft: "auto", fontFamily: F.code, fontSize: 9, fontWeight: 700, color: C.primary, border: `1px solid ${C.primary}50`, borderRadius: 999, padding: "2px 8px" }}>
                          ACTIVE
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Category Tabs */}
                  <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
                    {CATEGORY_ORDER.filter((k) => categories[k]).map((key) => {
                      const cat = categories[key];
                      return (
                        <button
                          key={key}
                          onClick={() => setActiveCategory(key)}
                          style={{
                            padding: "6px 12px", borderRadius: 6,
                            background: activeCategory === key ? C.secondaryContainer : C.surfaceContainerLow,
                            color: activeCategory === key ? C.onSecondaryContainer : C.onSurfaceVariant,
                            border: `1px solid ${activeCategory === key ? C.secondary : C.outlineVariant}`,
                            fontFamily: F.code, fontSize: 11,
                            fontWeight: activeCategory === key ? 700 : 400, cursor: "pointer",
                            display: "flex", alignItems: "center", gap: 6,
                          }}
                        >
                          <Icon name={cat.icon} size={14} color="currentColor" />
                          {cat.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Category Description */}
                  {categories[activeCategory] && (
                    <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: C.surfaceContainerLowest, border: `1px solid ${C.outlineVariant}`, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
                      <strong>{categories[activeCategory].label}:</strong> {categories[activeCategory].description}
                    </div>
                  )}

                  {/* Models in Category */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {(aurextraByCategory[activeCategory] || []).map((model) => {
                      const isSel = model.id === selected;
                      return (
                        <button
                          key={model.id}
                          onClick={() => choose(model.id)}
                          style={{
                            width: "100%", textAlign: "left", padding: "14px 16px", borderRadius: 10,
                            background: isSel ? `${C.primary}10` : C.surfaceContainerLow,
                            border: `1px solid ${isSel ? C.primary : C.outlineVariant}`,
                            color: C.onSurface, cursor: "pointer", transition: "all 0.15s", fontFamily: F.body,
                          }}
                          onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.borderColor = C.outline; }}
                          onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.borderColor = C.outlineVariant; }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <Icon name={isSel ? "radio_button_checked" : "radio_button_unchecked"} size={18} color={isSel ? C.primary : C.onSurfaceVariant} />
                            <span style={{ fontFamily: F.display, fontSize: 14, fontWeight: 700, color: isSel ? C.primary : C.onSurface }}>
                              {model.label ?? displayModel(model.id)}
                            </span>
                            {model.image && (
                              <span style={{ fontFamily: F.code, fontSize: 9, fontWeight: 700, color: C.primary, border: `1px solid ${C.primary}50`, borderRadius: 999, padding: "2px 8px" }}>VISION</span>
                            )}
                            {model.pdf && (
                              <span style={{ fontFamily: F.code, fontSize: 9, fontWeight: 700, color: C.tertiary, border: `1px solid ${C.tertiary}50`, borderRadius: 999, padding: "2px 8px" }}>PDF</span>
                            )}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, paddingLeft: 28, flexWrap: "wrap" }}>
                            <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>{model.id}</span>
                            {model.contextLength && (
                              <span style={{ fontFamily: F.code, fontSize: 9, fontWeight: 700, color: C.secondary, border: `1px solid ${C.secondary}50`, borderRadius: 999, padding: "2px 8px" }}>
                                {(model.contextLength / 1000).toFixed(0)}K CTX
                              </span>
                            )}
                          </div>
                          {model.description && (
                            <div style={{ marginTop: 6, paddingLeft: 28, fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>
                              {model.description}
                            </div>
                          )}
                        </button>
                      );
                    })}
                    {(aurextraByCategory[activeCategory] || []).length === 0 && (
                      <div style={{ padding: "20px", textAlign: "center", fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
                        No models in this category
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ─── OpenCode Tab ─── */}
              {activeTab === "opencode" && modelsData && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {modelsData.opencode.map((model) => {
                    const isSel = model.id === selected;
                    return (
                      <button
                        key={model.id}
                        onClick={() => choose(model.id)}
                        style={{
                          width: "100%", textAlign: "left", padding: "14px 16px", borderRadius: 10,
                          background: isSel ? `${C.primary}10` : C.surfaceContainerLow,
                          border: `1px solid ${isSel ? C.primary : C.outlineVariant}`,
                          color: C.onSurface, cursor: "pointer", transition: "all 0.15s", fontFamily: F.body,
                        }}
                        onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.borderColor = C.outline; }}
                        onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.borderColor = C.outlineVariant; }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <Icon name={isSel ? "radio_button_checked" : "radio_button_unchecked"} size={18} color={isSel ? C.primary : C.onSurfaceVariant} />
                          <span style={{ fontFamily: F.display, fontSize: 14, fontWeight: 700, color: isSel ? C.primary : C.onSurface }}>
                            {model.label ?? displayModel(model.id)}
                          </span>
                          {model.isDefault && (
                            <span style={{ fontFamily: F.code, fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", color: C.onSecondaryContainer, background: C.secondaryContainer, padding: "2px 8px", borderRadius: 999 }}>
                              DEFAULT
                            </span>
                          )}
                          {model.image && (
                            <span style={{ fontFamily: F.code, fontSize: 9, fontWeight: 700, color: C.primary, border: `1px solid ${C.primary}50`, borderRadius: 999, padding: "2px 8px" }}>VISION</span>
                          )}
                          {model.pdf && (
                            <span style={{ fontFamily: F.code, fontSize: 9, fontWeight: 700, color: C.tertiary, border: `1px solid ${C.tertiary}50`, borderRadius: 999, padding: "2px 8px" }}>PDF</span>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, paddingLeft: 28 }}>
                          <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>{model.id}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Footer */}
          <div style={{ marginTop: 20, padding: "10px 14px", borderRadius: 8, background: C.surfaceContainerLowest, border: `1px solid ${C.outlineVariant}`, fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>
            <strong>Auto Select:</strong> Analyzes your prompt and routes to the best model for the task (coding, reasoning, vision, etc.).
            <br />
            New runs use the selected model. Continue a chat to keep its original model.
          </div>
      </div>
    </ProjectShell>
  );
}
