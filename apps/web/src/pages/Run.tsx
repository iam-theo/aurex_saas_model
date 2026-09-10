import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type QuestionInfo, type Run, type Attachment, type Artifact } from "../api";
import { modelCapabilities } from "@aurex/shared/attachments";
import { useAuth } from "../auth";
import { C, F, PAD, Avatar, Icon, ProjectShell, TopBar } from "../components/project-ui";
import { ImageArtifact } from "../components/ImageArtifact";

// --- data model --------------------------------------------------------------

interface Todo {
  status: string;
  content: string;
  priority?: string;
}

interface LiveEvent {
  seq: number;
  type: string;
  data: {
    type?: string;
    role?: string;
    text?: string;
    part?: {
      type?: string;
      text?: string;
      reason?: string;
      tool?: string;
      state?: {
        input?: Record<string, unknown>;
        output?: string;
        title?: string;
        status?: string;
        metadata?: { exit?: number; output?: string; truncated?: boolean };
      };
    };
    requestId?: string;
    questions?: QuestionInfo[];
    answers?: string[][];
    rejected?: boolean;
    error?: string;
    artifact?: Artifact;
    action?: string;
  };
  createdAt: string;
}

interface QuestionState {
  requestId: string;
  questions: QuestionInfo[];
}

interface RunStatusMsg {
  status: string;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant" | "system";
  events: LiveEvent[];
}

// --- message building blocks -------------------------------------------------

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {todos.map((t, i) => {
        const done = t.status === "completed";
        const active = t.status === "in_progress";
        return (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: done ? C.primary : active ? C.secondary : C.outline,
              }}
            >
              {done ? "●" : active ? "◔" : "○"}
            </span>
            <span
              style={{
                color: C.onSurface,
                fontSize: 13,
                lineHeight: 1.5,
                textDecoration: done ? "line-through" : "none",
                opacity: done ? 0.55 : 1,
              }}
            >
              {t.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const TOOL_ICON: Record<string, string> = {
  write: "edit_document",
  edit: "edit",
  create: "add_box",
  bash: "terminal",
  todos: "checklist",
  glob: "folder_open",
  grep: "search",
  read: "description",
  webfetch: "language",
  websearch: "search",
};

function toolDescription(tool: string, input: Record<string, unknown>): string {
  const filePath = typeof input.filePath === "string" ? input.filePath : "";
  const command = typeof input.command === "string" ? input.command : "";
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const query = typeof input.query === "string" ? input.query : "";
  const url = typeof input.url === "string" ? input.url : "";
  const filename = typeof input.filename === "string" ? input.filename : "";
  switch (tool) {
    case "write": case "edit": case "create": return filePath || tool;
    case "bash": return command ? `$ ${command}` : "running…";
    case "glob": return pattern || tool;
    case "grep": return query || pattern || tool;
    case "read": return filePath || tool;
    case "webfetch": return url || tool;
    case "websearch": return query || tool;
    case "question": return "Question";
    default: return tool;
  }
}

function ToolOutput({ tool, input, output, exit }: { tool: string; input: Record<string, unknown>; output: string; exit?: number }) {
  const [open, setOpen] = useState(false);
  if (!output) return null;

  const maxLines = 4;
  const lines = output.split("\n");
  const truncated = lines.length > maxLines;
  const preview = truncated ? lines.slice(0, maxLines).join("\n") : output;

  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "transparent",
          border: "none",
          fontFamily: F.code,
          fontSize: 11,
          color: C.onSurfaceVariant,
          cursor: "pointer",
          padding: "2px 0",
        }}
      >
        <Icon name={open ? "expand_less" : "expand_more"} size={13} color="currentColor" />
        {open ? "collapse" : `${lines.length} lines`}
        {typeof exit === "number" && exit !== 0 && (
          <span style={{ color: C.error, marginLeft: 4 }}>exit {exit}</span>
        )}
      </button>
      {open && (
        <pre
          style={{
            fontFamily: F.code,
            fontSize: 12,
            lineHeight: 1.5,
            color: C.onSurfaceVariant,
            margin: 0,
            marginTop: 6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: C.surfaceContainerLow,
            borderRadius: 6,
            padding: 10,
          }}
        >
          {output}
        </pre>
      )}
      {!open && truncated && (
        <pre
          style={{
            fontFamily: F.code,
            fontSize: 11,
            lineHeight: 1.4,
            color: C.outline,
            margin: 0,
            marginTop: 4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {preview}
          {"\n..."}
        </pre>
      )}
    </div>
  );
}

function ToolInline({ evt, live }: { evt: LiveEvent; live: boolean }) {
  const part = evt.data.part;
  const tool = part?.tool ?? "";
  const state = part?.state;
  const status = state?.status;
  const isRunning = live && status !== "completed" && status !== "error";
  const input = state?.input ?? {};
  const output = state?.output ?? state?.metadata?.output ?? "";
  const exit = state?.metadata?.exit;
  const todos = Array.isArray(input.todos) ? (input.todos as Todo[]) : [];
  const failed = status === "error";

  const icon = failed ? "close" : (TOOL_ICON[tool] ?? "build");
  const desc = todos.length > 0 ? `${todos.length} tasks` : toolDescription(tool, input);
  const hasOutput = output && output.trim().length > 0;

  const command = typeof input.command === "string" ? input.command : "";
  const filePath = typeof input.filePath === "string" ? input.filePath : "";

  return (
    <div style={{ paddingLeft: 24, marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span
          style={{
            width: 20,
            height: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          {isRunning ? (
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 999,
                border: `2px solid ${C.primary}30`,
                borderTopColor: C.primary,
                animation: "aurex-spin 0.8s linear infinite",
              }}
            />
          ) : (
            <Icon name={icon} size={15} color={failed ? C.error : C.onSurfaceVariant} />
          )}
        </span>
        <span
          style={{
            fontFamily: F.code,
            fontSize: 12,
            lineHeight: 1.5,
            color: failed ? C.error : C.onSurfaceVariant,
          }}
        >
          {desc}
          {isRunning && (
            <span style={{ color: C.outline, marginLeft: 6 }}>running…</span>
          )}
        </span>
      </div>

      {isRunning && (tool === "write" || tool === "edit" || tool === "create") && filePath && (
        <div style={{ paddingLeft: 28, marginTop: 4 }}>
          <span style={{ fontFamily: F.code, fontSize: 11, color: C.outline }}>
            writing {filePath}
          </span>
        </div>
      )}

      {isRunning && tool === "bash" && command && (
        <div style={{ paddingLeft: 28, marginTop: 4 }}>
          <span style={{ fontFamily: F.code, fontSize: 11, color: C.outline }}>
            $ {command}
          </span>
        </div>
      )}

      {!isRunning && hasOutput && (
        <div style={{ paddingLeft: 28 }}>
          <ToolOutput tool={tool} input={input} output={output} exit={exit} />
        </div>
      )}

      {todos.length > 0 && !isRunning && (
        <div style={{ paddingLeft: 28 }}>
          <TodoList todos={todos} />
        </div>
      )}
    </div>
  );
}

// --- chat message renderers --------------------------------------------------

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ paddingLeft: 24, marginTop: 8 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "transparent",
          border: "none",
          fontFamily: F.code,
          fontSize: 11,
          color: C.onSurfaceVariant,
          cursor: "pointer",
          padding: "2px 0",
        }}
      >
        <Icon name={open ? "expand_less" : "expand_more"} size={13} color="currentColor" />
        Thinking
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            padding: "10px 14px",
            background: C.surfaceContainerLow,
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1.6,
            color: C.onSurfaceVariant,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

type AgentBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; evt: LiveEvent }
  | { kind: "step_start" }
  | { kind: "step_finish"; reason?: string }
  | { kind: "artifact"; artifact: Artifact };

function buildAgentBlocks(events: LiveEvent[]): AgentBlock[] {
  const out: AgentBlock[] = [];
  let textBuf = "";
  let reasonBuf = "";
  const flush = () => {
    if (textBuf.trim()) out.push({ kind: "text", text: textBuf.trim() });
    if (reasonBuf.trim()) out.push({ kind: "reasoning", text: reasonBuf.trim() });
    textBuf = "";
    reasonBuf = "";
  };
  for (const evt of events) {
    const ptype = evt.data.part?.type;
    if (evt.type === "artifact" && evt.data.artifact) {
      flush();
      out.push({ kind: "artifact", artifact: evt.data.artifact });
    } else if (evt.type === "tool" || ptype === "tool") {
      flush();
      // Merge: if the last block is a tool with the same part ID, update it in place.
      const partId = (evt.data.part as Record<string, unknown>)?.id as string | undefined;
      if (partId && out.length > 0 && out[out.length - 1].kind === "tool") {
        const last = out[out.length - 1] as { kind: "tool"; evt: LiveEvent; partId?: string };
        if (last.partId === partId) {
          last.evt = evt;
          continue;
        }
      }
      const block: { kind: "tool"; evt: LiveEvent; partId?: string } = { kind: "tool", evt };
      if (partId) block.partId = partId;
      out.push(block);
    } else if (evt.type === "step_start" || ptype === "step-start") {
      flush();
      out.push({ kind: "step_start" });
    } else if (evt.type === "step_finish" || ptype === "step-finish") {
      flush();
      out.push({ kind: "step_finish", reason: evt.data.part?.reason });
    } else if (evt.type === "reasoning" || ptype === "reasoning") {
      flush();
      reasonBuf = (evt.data.part?.text ?? evt.data.text ?? "") + "\n";
    } else {
      const t =
        evt.type === "text"
          ? evt.data.part?.text ?? ""
          : evt.type === "message"
            ? evt.data.role !== "user"
              ? evt.data.text ?? ""
              : ""
            : ptype === "text"
              ? evt.data.part?.text ?? ""
              : "";
      if (t) {
        flush();
        textBuf = t;
      }
    }
  }
  flush();
  return out;
}

function Dots() {
  const frames = [".", "..", "...", "....", ".....", "......"];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 300);
    return () => clearInterval(id);
  }, []);
  return <span style={{ width: "2.4em", textAlign: "left" }}>{frames[frame]}</span>;
}

function AgentMessage({ events, live, projectId }: { events: LiveEvent[]; live: boolean; projectId?: string }) {
  const blocks = useMemo(() => buildAgentBlocks(events), [events]);
  return (
    <div style={{ width: "100%", margin: "0 auto" }}>
      {blocks.map((b, i) => {
        if (b.kind === "text") {
          return (
            <div
              key={i}
              style={{
                paddingLeft: 24,
                marginBottom: 12,
                fontSize: 14,
                lineHeight: 1.7,
                color: C.onSurface,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {b.text}
            </div>
          );
        }
        if (b.kind === "reasoning") return <ThinkingBlock key={i} text={b.text} />;
        if (b.kind === "tool") return <ToolInline key={i} evt={b.evt} live={live} />;
        if (b.kind === "artifact" && projectId) {
          return <div key={i} style={{ paddingLeft: 24, marginBottom: 12 }}><ImageArtifact artifact={b.artifact} projectId={projectId} /></div>;
        }
        if (b.kind === "step_start") {
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 12px" }}>
              <span style={{ fontFamily: F.code, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: C.outline, flexShrink: 0 }}>
                Step
              </span>
              <div style={{ flex: 1, height: 1, background: C.outlineVariant }} />
            </div>
          );
        }
        if (b.kind === "step_finish") {
          return (
            <div key={i} style={{ paddingLeft: 24, display: "flex", alignItems: "center", gap: 8, marginTop: 4, marginBottom: 12, fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
              <span style={{ color: C.primary }}>✔</span>
              <span>{b.reason || "step finished"}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function UserMessage({ text, avatarUrl, name }: { text: string; avatarUrl?: string | null; name: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, width: "100%", margin: "0 auto" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.65,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: C.primaryContainer,
            color: C.onPrimaryContainer,
            padding: "8px 14px",
            borderRadius: "14px 14px 4px 14px",
            maxWidth: 800,
          }}
        >
          {text}
        </div>
      </div>
      <Avatar src={avatarUrl} name={name} />
    </div>
  );
}

function SystemPill({ text, kind }: { text: string; kind?: "error" | "info" }) {
  const isError = kind === "error";
  return (
    <div style={{ display: "flex", justifyContent: "center", margin: "16px 0" }}>
      <span
        style={{
          fontFamily: F.code,
          fontSize: 11,
          color: isError ? C.error : C.onSurfaceVariant,
          background: isError ? `${C.error}14` : C.surfaceContainerHigh,
          border: `1px solid ${isError ? `${C.error}40` : `${C.outlineVariant}30`}`,
          padding: "4px 12px",
          borderRadius: 999,
          textAlign: "center",
        }}
      >
        {text}
      </span>
    </div>
  );
}


// --- interactive question prompt (mirrors opencode's question tool) ---------

function QuestionPrompt({
  question,
  active,
  onSubmitted,
}: {
  question: QuestionState;
  active: boolean;
  onSubmitted: (requestId: string, answers: string[][]) => Promise<void>;
}) {
  const questions = question.questions;
  const single = questions.length === 1 && questions[0].multiple !== true;
  const [tab, setTab] = useState(0);
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ""));
  const [customEdit, setCustomEdit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const confirm = !single && tab === questions.length;
  const current = questions[tab];
  const multi = current?.multiple === true;
  const allowCustom = current?.custom !== false;
  const currentAnswer = answers[tab] ?? [];

  useEffect(() => {
    if (active && cardRef.current) cardRef.current.focus();
  }, [active]);

  const submit = async (ans: string[][]) => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmitted(question.requestId, ans);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const pickOne = (label: string) => {
    const next = answers.map((a, i) => (i === tab ? [label] : a));
    setAnswers(next);
    if (single) void submit(next);
    else setTab((t) => t + 1);
  };

  const toggle = (label: string) => {
    setAnswers((prev) => {
      const next = prev.map((a) => [...a]);
      const cur = next[tab] ?? [];
      const i = cur.indexOf(label);
      if (i === -1) cur.push(label);
      else cur.splice(i, 1);
      next[tab] = cur;
      return next;
    });
  };

  const pickCustom = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setCustom((prev) => prev.map((c, i) => (i === tab ? trimmed : c)));
    const next = answers.map((a, i) => (i === tab ? [trimmed] : a));
    setAnswers(next);
    setCustomEdit(false);
    if (single) void submit(next);
    else setTab((t) => t + 1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!active || submitting) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (confirm) {
        void submit(answers.map((a) => [...a]));
      } else {
        setTab((t) => Math.min(t + 1, questions.length));
      }
    }
  };

  const card: CSSProperties = {
    width: "100%",
    margin: "0 auto",
    marginBottom: 16,
    background: C.surfaceContainerLow,
    border: `1px solid ${C.outlineVariant}`,
    borderRadius: 8,
    padding: 16,
    outline: "none",
    boxShadow: active ? `0 0 16px rgba(78,222,163,0.12)` : "none",
  };

  const titleStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: F.code,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: C.onSurface,
    marginBottom: 12,
  };

  const markStyle: CSSProperties = {
    width: 20,
    height: 20,
    borderRadius: 999,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 700,
    background: C.secondaryContainer,
    color: C.onSecondaryContainer,
  };

  const tabBtn = (picked: boolean): CSSProperties => ({
    padding: "6px 12px",
    borderRadius: 6,
    border: `1px solid ${picked ? C.secondaryContainer : C.outlineVariant}`,
    background: picked ? C.secondaryContainer : "transparent",
    color: picked ? C.onSecondaryContainer : C.onSurfaceVariant,
    fontFamily: F.code,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    cursor: "pointer",
  });

  const optionRow = (picked: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    width: "100%",
    textAlign: "left",
    background: picked ? `${C.secondaryContainer}1a` : C.surfaceContainerHigh,
    border: `1px solid ${picked ? `${C.secondaryContainer}70` : C.outlineVariant}`,
    borderRadius: 8,
    cursor: "pointer",
    color: C.onSurface,
  });

  if (!active) {
    return (
      <div style={{ ...card, opacity: 0.6 }}>
        <div style={titleStyle}>
          <span style={markStyle}>…</span> Question
        </div>
        <div style={{ fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant }}>
          waiting for your previous answer…
        </div>
      </div>
    );
  }

  return (
    <div style={card} tabIndex={0} ref={cardRef} onKeyDown={onKeyDown}>
      <div style={titleStyle}>
        <span style={markStyle}>?</span>
        {single ? "Question" : `Question ${tab + 1} of ${questions.length}`}
      </div>

      {!single && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {questions.map((q, i) => (
            <button key={i} style={tabBtn(i === tab)} onClick={() => setTab(i)}>
              {q.header}
              {answers[i]?.length ? " ✓" : ""}
            </button>
          ))}
          <button style={tabBtn(confirm)} onClick={() => setTab(questions.length)}>
            Confirm
          </button>
        </div>
      )}

      {!confirm ? (
        <div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: C.onSurface, marginBottom: 12 }}>
            {current.question}
            {multi ? " (select all that apply)" : ""}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {current.options.map((opt, i) => {
              const picked = currentAnswer.includes(opt.label);
              return (
                <button
                  key={i}
                  style={optionRow(picked)}
                  onClick={() => (multi ? toggle(opt.label) : pickOne(opt.label))}
                >
                  <span style={{ color: C.secondary, fontSize: 14, lineHeight: 1.4 }}>
                    {multi ? (picked ? "☑" : "☐") : picked ? "◉" : "○"}
                  </span>
                  <span style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</span>
                    {opt.description && (
                      <span style={{ display: "block", fontSize: 12, color: C.onSurfaceVariant, marginTop: 2 }}>
                        {opt.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {allowCustom && (
              <div style={{ ...optionRow(false), flexDirection: "column", gap: 8, background: customEdit ? C.surfaceContainerHigh : undefined }}>
                <button
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    color: C.onSurface,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  onClick={() => {
                    // toggle custom editor; if a custom value already exists, remove it from answers so it can be re-edited
                    if (customEdit) {
                      setCustomEdit(false);
                      return;
                    }
                    if (custom[tab]) {
                      const value = custom[tab];
                      if (multi) {
                        setAnswers((prev) => prev.map((a, i) => (i === tab ? a.filter((x) => x !== value) : a)));
                      } else {
                        setAnswers((prev) => prev.map((a, i) => (i === tab ? [] : a)));
                      }
                    }
                    setCustomEdit(true);
                  }}
                >
                  <span style={{ color: C.secondary, fontSize: 14 }}>
                    {single && custom[tab] ? "◉" : "○"}
                  </span>
                  <span style={{ fontSize: 13 }}>
                    {multi && custom[tab] ? `custom: ${custom[tab]}` : "Type your own answer"}
                  </span>
                </button>
                {customEdit && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      autoFocus
                      value={custom[tab]}
                      onChange={(e) => setCustom((prev) => prev.map((c, i) => (i === tab ? e.target.value : c)))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.stopPropagation();
                          pickCustom(custom[tab]);
                        }
                      }}
                      placeholder="Type your own answer"
                      style={{
                        flex: 1,
                        padding: "8px 12px",
                        borderRadius: 6,
                        border: `1px solid ${C.outlineVariant}`,
                        background: C.surfaceContainerLowest,
                        color: C.onSurface,
                        fontFamily: F.code,
                        fontSize: 13,
                        outline: "none",
                      }}
                    />
                    <button
                      style={sendBtn}
                      onClick={() => pickCustom(custom[tab])}
                    >
                      ok
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: C.onSurface, marginBottom: 12 }}>Review</div>
          {questions.map((q, i) => (
            <div key={i} style={{ fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant, marginBottom: 6 }}>
              <span style={{ color: C.onSurface }}>{q.header}:</span>{" "}
              <span style={{ color: answers[i]?.length ? C.primary : C.outline }}>
                {answers[i]?.join(", ") || "(not answered)"}
              </span>
            </div>
          ))}
        </div>
      )}

      {submitError && (
        <div style={{ marginTop: 12, fontFamily: F.code, fontSize: 12, color: C.error }}>{submitError}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
        {!single && tab > 0 && (
          <button
            style={ghostBtn}
            onClick={() => setTab(tab - 1)}
          >
            ← back
          </button>
        )}
        <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, flex: 1, textAlign: "center" }}>
          {confirm
            ? "press Enter to confirm"
            : multi
              ? "select all that apply"
              : single
                ? "select an option to submit"
                : "select an option, then press Enter"}
        </span>
        {!single &&
          (confirm ? (
            <button
              style={{ ...sendBtn, opacity: submitting ? 0.6 : 1 }}
              onClick={() => void submit(answers.map((a) => [...a]))}
              disabled={submitting}
            >
              {submitting ? "confirming…" : "confirm ↵"}
            </button>
          ) : (
            <button
              style={{ ...sendBtn, opacity: answers[tab]?.length ? 1 : 0.5 }}
              onClick={() => setTab((t) => Math.min(t + 1, questions.length))}
              disabled={!answers[tab]?.length}
            >
              next →
            </button>
          ))}
      </div>
    </div>
  );
}

const sendBtn: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "none",
  background: C.primary,
  color: "#000",
  fontFamily: F.code,
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
};

const ghostBtn: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: `1px solid ${C.outlineVariant}`,
  background: "transparent",
  color: C.onSurfaceVariant,
  fontFamily: F.code,
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
};

// --- input bar ---------------------------------------------------------------

function InputBar({
  draft,
  setDraft,
  onSend,
  sending,
  status,
  aborting,
  onAbort,
  chatLocked,
  uploadingChat,
  onPickFiles,
  chatAttachments,
  onRemoveAttachment,
  awaitingAnswer,
  chatExtract,
  canAttach,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  status: string;
  aborting: boolean;
  onAbort: () => void;
  chatLocked: boolean;
  uploadingChat: boolean;
  onPickFiles: (files: FileList | null) => void;
  chatAttachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  awaitingAnswer: boolean;
  chatExtract: boolean;
  canAttach: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const running = status === "queued" || status === "running";

  const resize = () => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "";
      ta.style.height = `${ta.scrollHeight}px`;
    }
  };

  const placeholder = awaitingAnswer
        ? "answer the question above…"
        : status === "queued"
          ? "waiting for Aurex to start…"
          : status === "running"
            ? "Aurex is working — wait for it to finish…"
            : "Ask Aurex ...";

  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        padding: PAD,
        background: "linear-gradient(to top, rgba(14,21,17,1), rgba(14,21,17,0.9) 60%, transparent)",
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: "100%",
          background: C.surfaceContainerHighest,
          border: `1px solid ${C.outlineVariant}`,
          borderRadius: 12,
          padding: 8,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 -2px 16px rgba(0,0,0,0.4)",
          pointerEvents: "auto",
        }}
      >
        {chatAttachments.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 8px 8px" }}>
            {chatAttachments.map((a) => (
              <span
                key={a.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  background: C.surfaceContainer,
                  border: `1px solid ${C.outlineVariant}`,
                  borderRadius: 6,
                  fontFamily: F.code,
                  fontSize: 11,
                  color: C.onSurface,
                }}
              >
                <span>{a.modality === "image" ? "🖼" : a.modality === "pdf" ? "📄" : "📝"}</span>
                {a.name}
                <button
                  onClick={() => onRemoveAttachment(a.id)}
                  style={{ background: "transparent", border: "none", color: C.onSurfaceVariant, cursor: "pointer", padding: 0, lineHeight: 1 }}
                  aria-label={`Remove ${a.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {chatExtract && (
          <div
            style={{
              margin: "0 8px 8px",
              padding: "8px 10px",
              borderRadius: 6,
              background: `${C.secondaryContainer}14`,
              border: `1px solid ${C.secondaryContainer}30`,
              fontFamily: F.code,
              fontSize: 11,
              color: C.onSurfaceVariant,
            }}
          >
            Images/PDFs will be read via OCR text extraction — switch to a vision model to see them natively.
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            resize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          disabled={chatLocked}
          style={{
            width: "100%",
            background: "transparent",
            border: "none",
            color: C.onSurface,
            fontFamily: F.code,
            fontSize: 13,
            lineHeight: 1.5,
            resize: "none",
            padding: 8,
            maxHeight: 128,
            outline: "none",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 8px 0",
            borderTop: `1px solid ${C.outlineVariant}30`,
            marginTop: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <label
              style={{
                width: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: C.onSurfaceVariant,
                borderRadius: 8,
                cursor: canAttach && !chatLocked ? "pointer" : "not-allowed",
                opacity: canAttach && !chatLocked ? 1 : 0.4,
              }}
              title="Attach file"
            >
              <Icon name="attach_file" size={18} color="currentColor" />
              <input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/x-markdown"
                onChange={(e) => {
                  onPickFiles(e.target.files);
                  e.target.value = "";
                }}
                disabled={!canAttach || chatLocked}
                style={{ display: "none" }}
              />
            </label>
            {uploadingChat && (
              <span style={{ fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant }}>uploading…</span>
            )}
          </div>
          {running ? (
            <button
              onClick={onAbort}
              disabled={aborting}
              title="Stop the current request"
              style={{
                width: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: C.secondaryContainer,
                color: C.onSecondaryContainer,
                borderRadius: 8,
                border: `1px solid ${C.secondaryContainer}50`,
                cursor: aborting ? "default" : "pointer",
                animation: "aurex-pulse-glow 2s cubic-bezier(0.4,0,0.6,1) infinite",
              }}
            >
              <Icon name="stop" size={18} color="currentColor" fill />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={chatLocked || !draft.trim()}
              title="Send message"
              style={{
                width: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: C.primary,
                color: "#000",
                borderRadius: 8,
                border: `1px solid ${C.primary}`,
                cursor: chatLocked || !draft.trim() ? "default" : "pointer",
                opacity: chatLocked || !draft.trim() ? 0.5 : 1,
              }}
            >
              <Icon name="arrow_upward" size={18} color="#000" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Page --------------------------------------------------------------------

export default function Run() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [run, setRun] = useState<Run | null>(null);
  const [projectName, setProjectName] = useState("");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [status, setStatus] = useState<string>("queued");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [questions, setQuestions] = useState<QuestionState[]>([]);
  const [aborting, setAborting] = useState(false);
  const [runAttachments, setRunAttachments] = useState<Attachment[]>([]);
  const [chatAttachments, setChatAttachments] = useState<Attachment[]>([]);
  const [uploadingChat, setUploadingChat] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [metrics, setMetrics] = useState<{ cpuPct: number | null; memUsed: number | null; memLimit: number | null; pids: number | null; uptimeSeconds: number | null; status: string | null } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distFromBottom > 400);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Observability: live workspace metrics polling (5s when live, 15s when finished)
  useEffect(() => {
    if (!run?.workspaceId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await api.getWorkspaceStatus(run.workspaceId!);
        if (!alive) return;
        setMetrics({ cpuPct: s.stats?.cpuPct ?? null, memUsed: s.stats?.memUsed ?? null, memLimit: s.stats?.memLimit ?? null, pids: s.stats?.pids ?? null, uptimeSeconds: s.uptimeSeconds ?? null, status: s.status ?? null });
      } catch { /* ignore */ }
      if (!alive) return;
      const finished = ["completed", "failed", "cancelled", "timeout"].includes(status);
      timer = setTimeout(poll, finished ? 15000 : 4000);
    };
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [run?.workspaceId, status]);

  const upsertQuestion = (q: QuestionState) => {
    setQuestions((prev) => {
      const i = prev.findIndex((p) => p.requestId === q.requestId);
      if (i === -1) return [...prev, q];
      const next = [...prev];
      next[i] = { ...next[i], ...q };
      return next;
    });
  };

  const markAnswered = (requestId: string) => {
    setQuestions((prev) => prev.filter((p) => p.requestId !== requestId));
  };

  const applyEvent = (evt: LiveEvent) => {
    setEvents((prev) => {
      if (prev.some((p) => p.seq === evt.seq)) return prev;
      return [...prev, evt];
    });
    if (evt.type === "question") {
      if (evt.data.requestId && evt.data.questions) {
        upsertQuestion({
          requestId: evt.data.requestId,
          questions: evt.data.questions,
        });
      }
    } else if (evt.type === "question_reply" && evt.data.requestId) {
      markAnswered(evt.data.requestId);
    }
  };

  const submitQuestion = async (requestId: string, answers: string[][]) => {
    if (!runId) return;
    await api.answerRunQuestion(runId, requestId, answers);
    markAnswered(requestId);
  };

  const sendMessage = async () => {
    const text = draft.trim();
    if (!runId || !text || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendRunMessage(runId, text, chatAttachments.map((a) => a.id));
      setDraft("");
      setRunAttachments((prev) => [...prev, ...chatAttachments]);
      setChatAttachments([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const pickChatFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !run || uploadingChat) return;
    setUploadingChat(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const res = await api.uploadAttachment(run.projectId, file);
        setChatAttachments((prev) => [...prev, res.attachment]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingChat(false);
    }
  };

  const abortRun = async () => {
    if (!runId || aborting) return;
    setAborting(true);
    setError(null);
    try {
      await api.abortRun(runId);
      setStatus("cancelled");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAborting(false);
    }
  };

  const [retrying, setRetrying] = useState(false);
  const retryRun = async () => {
    if (!runId || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      await api.retryRun(runId);
      setStatus("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  useEffect(() => {
    if (!runId) return;
    api
      .getRun(runId)
      .then((r) => {
        setRun(r);
        setStatus(r.status);
        if (r.events && r.events.length > 0) {
          r.events.forEach((e) => applyEvent({ ...e }));
        }
        api
          .getProject(r.projectId)
          .then((p) => setProjectName(p.name))
          .catch(() => undefined);
      })
      .catch((e) => setError(e.message));

    api
      .listRunAttachments(runId)
      .then((r) => setRunAttachments(r.attachments))
      .catch(() => undefined);

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 1000;

    const connect = () => {
      es = new EventSource(`/api/runs/${runId}/events`);
      es.addEventListener("open", () => {
        setConnected(true);
        reconnectDelay = 1000;
      });
      es.addEventListener("error", () => {
        setConnected(false);
        es?.close();
        es = null;
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
          connect();
        }, reconnectDelay);
      });
      es.addEventListener("run", (e) => {
        const msg = JSON.parse((e as MessageEvent).data) as RunStatusMsg;
        setStatus(msg.status);
        setRun((prev) => (prev ? { ...prev, status: msg.status } : prev));
      });
      es.addEventListener("event", (e) => {
        const evt = JSON.parse((e as MessageEvent).data) as LiveEvent;
        applyEvent(evt);
      });
    };

    connect();

    return () => {
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [runId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, status]);

  const messages = useMemo<ChatMsg[]>(() => {
    const out: ChatMsg[] = [];
    for (const evt of events) {
      if (evt.type === "question" || evt.type === "question_reply") continue;
      let role: ChatMsg["role"];
      if (evt.type === "message" && evt.data.role === "user") role = "user";
      else if (evt.type === "system" || evt.type === "error") role = "system";
      else role = "assistant";
      const last = out[out.length - 1];
      if (last && last.role === role) last.events.push(evt);
      else out.push({ id: `m-${evt.seq}`, role, events: [evt] });
    }
    return out;
  }, [events]);

  const statusText = useMemo(() => {
    if (status !== "running") return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const t = events[i].type;
      if (t === "reasoning") return "thinking";
      if (t === "tool" || t === "step_start") return "building";
      if (t === "text" || t === "message") return "writing";
    }
    return "thinking";
  }, [events, status]);

  if (!run) {
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
          Loading run…
        </div>
      </div>
    );
  }

  const finished = ["completed", "failed", "cancelled", "timeout"].includes(status);
  const live = connected && !finished;
  const awaitingAnswer = questions.length > 0;
  const chatLocked = awaitingAnswer || status === "queued" || status === "running" || sending;
  const caps = modelCapabilities(run.model);
  const chatExtract = chatAttachments.some(
    (a) => (a.modality === "image" && !caps.image) || (a.modality === "pdf" && !caps.pdf),
  );

  const userName = user?.name ?? user?.email ?? "User";

  return (
    <ProjectShell
      projectId={run.projectId}
      active="chat"
      chatHref={`/runs/${runId}`}
      onLogout={() => void handleLogout()}
      topBar={
        <TopBar
          projectName={projectName || "—"}
          status={status}
          connected={connected}
          avatarUrl={user?.avatarUrl}
          userName={userName}
          onLogout={() => void handleLogout()}
          actions={
            <Link
              to={`/projects/${run.projectId}?new=1`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                marginRight: 4,
                borderRadius: 8,
                border: `1px solid ${C.primary}`,
                color: C.primary,
                fontFamily: F.code,
                fontSize: 11,
                fontWeight: 700,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              <Icon name="add" size={14} color="currentColor" />
              New Run
            </Link>
          }
        />
      }
    >
      {/* Observability bar — live container metrics + status */}
      {metrics && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: C.surfaceContainerLow, borderBottom: `1px solid ${C.outlineVariant}`, fontFamily: F.code, fontSize: 11, color: C.onSurfaceVariant, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: status === "running" ? C.primary : status === "failed" ? C.error : C.outline }} />{status}</span>
          {metrics.cpuPct != null && <span>CPU {metrics.cpuPct.toFixed(1)}%</span>}
          {metrics.memUsed != null && <span>MEM {Math.round(metrics.memUsed / 1024 / 1024)}MB{metrics.memLimit ? ` / ${Math.round(metrics.memLimit / 1024 / 1024)}MB` : ""}</span>}
          {metrics.pids != null && <span>PIDs {metrics.pids}</span>}
          {metrics.uptimeSeconds != null && <span>up {Math.floor(metrics.uptimeSeconds / 60)}m {metrics.uptimeSeconds % 60}s</span>}
          <span style={{ marginLeft: "auto", color: C.outline }}>{metrics.status ?? ""}</span>
          {connected ? <span style={{ color: C.primary }}>● live</span> : <span style={{ color: C.outline }}>○ reconnecting</span>}
        </div>
      )}
      {(status === "failed" || status === "timeout") && (
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 12px", background: `${C.error}0f`, borderBottom: `1px solid ${C.error}30`, gap: 8 }}>
          <span style={{ fontFamily: F.code, fontSize: 11, color: C.error, alignSelf: "center" }}>Run {status === "timeout" ? "timed out" : "failed"} — you can retry to continue</span>
          <button onClick={() => void retryRun()} disabled={retrying} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.error}`, background: retrying ? C.surfaceContainerHigh : C.error, color: retrying ? C.onSurfaceVariant : "#fff", fontFamily: F.code, fontSize: 11, fontWeight: 700, cursor: retrying ? "default" : "pointer", opacity: retrying ? 0.6 : 1 }}>{retrying ? "Retrying…" : "↻ Retry & Continue"}</button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="aurex-scroll"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: PAD,
          display: "flex",
          flexDirection: "column",
          gap: 24,
          scrollBehavior: "smooth",
        }}
      >
            {error && <SystemPill text={error} kind="error" />}
            {connected && <SystemPill text="Session started. Aurex-Core loaded. Verify loop: build → test → debug until green." />}

            {messages.length === 0 && (
              <SystemPill text="Waiting for Aurex activity…" />
            )}

            {messages.map((m) => {
              if (m.role === "user") {
                const text = m.events.map((e) => e.data.text ?? e.data.part?.text ?? "").join("\n");
                return <UserMessage key={m.id} text={text} avatarUrl={user?.avatarUrl} name={userName} />;
              }
              if (m.role === "system") {
                const text = m.events
                  .map((e) => e.data.text ?? e.data.error ?? e.data.part?.text ?? "")
                  .join("\n")
                  .trim();
                if (!text) return null;
                return <SystemPill key={m.id} text={text} kind={m.events.some((e) => e.type === "error") ? "error" : "info"} />;
              }
              return <AgentMessage key={m.id} events={m.events} live={live} projectId={run?.projectId} />;
            })}

            {questions.map((q, i) => (
              <QuestionPrompt key={q.requestId} question={q} active={i === 0} onSubmitted={submitQuestion} />
            ))}

            {runAttachments.length > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {runAttachments.map((a) => (
                  <span
                    key={a.id}
                    title={a.name}
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
                    <span>{a.modality === "image" ? "🖼" : a.modality === "pdf" ? "📄" : "📝"}</span>
                    {a.name}
                  </span>
                ))}
              </div>
            )}

            {live && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", margin: "0 auto" }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: C.secondary, animation: "aurex-blink 1s ease-in-out infinite", flexShrink: 0 }} />
                <span style={{ fontFamily: F.code, fontSize: 12, color: C.onSurfaceVariant, display: "flex" }}>
                  <span>{statusText || "working"}</span>
                  <Dots />
                </span>
              </div>
            )}

            <div style={{ height: 120, flexShrink: 0 }} />
          </div>

          {showScrollBtn && (
            <button
              onClick={() => {
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
                setShowScrollBtn(false);
              }}
              style={{
                position: "absolute",
                bottom: 100,
                left: "50%",
                transform: "translateX(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: C.surfaceContainerHigh,
                border: `1px solid ${C.outlineVariant}`,
                borderRadius: 999,
                padding: "8px 16px",
                cursor: "pointer",
                color: C.onSurface,
                fontFamily: F.code,
                fontSize: 12,
                fontWeight: 600,
                boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
                zIndex: 10,
                transition: "opacity 0.2s",
              }}
            >
              <Icon name="keyboard_arrow_down" size={16} color={C.primary} />
              Latest
            </button>
          )}

          <InputBar
            draft={draft}
            setDraft={setDraft}
            onSend={() => void sendMessage()}
            sending={sending}
            status={status}
            aborting={aborting}
            onAbort={() => void abortRun()}
            chatLocked={chatLocked}
            uploadingChat={uploadingChat}
            onPickFiles={pickChatFiles}
            chatAttachments={chatAttachments}
            onRemoveAttachment={(id) => setChatAttachments((prev) => prev.filter((x) => x.id !== id))}
            awaitingAnswer={awaitingAnswer}
            chatExtract={chatExtract}
            canAttach={!!run}
          />
    </ProjectShell>
  );
}
