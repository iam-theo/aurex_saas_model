import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
function resolvePromptsDir(): string {
  const candidates = [
    resolvePath(__dirname, "..", "..", "..", "..", "prompts"),
    resolvePath(__dirname, "..", "..", "prompts"),
    resolvePath(process.cwd(), "prompts"),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "core"))) return p;
  }
  return candidates[0];
}
const PROMPTS_DIR = resolvePromptsDir();

let _warnedMissing = false;
function warnIfMissing() {
  if (!_warnedMissing && !existsSync(PROMPTS_DIR)) {
    console.warn(`[prompts] prompts directory not found at ${PROMPTS_DIR} — using built-in fallback prompts`);
    _warnedMissing = true;
  }
}

export interface PromptMeta {
  id: string;
  category: "core" | "capability" | "workflow";
  name: string;
  description: string;
  keywords: string[];
  file: string;
}

export function loadPromptFile(relPath: string): string | null {
  try {
    const fullPath = join(PROMPTS_DIR, relPath);
    if (!existsSync(fullPath)) {
      warnIfMissing();
      return null;
    }
    return readFileSync(fullPath, "utf8");
  } catch {
    warnIfMissing();
    return null;
  }
}

export function discoverPrompts(): PromptMeta[] {
  const discovered: PromptMeta[] = [];
  const categories: Array<{ dir: string; cat: "core" | "capability" | "workflow" }> = [
    { dir: "core", cat: "core" },
    { dir: "capabilities", cat: "capability" },
    { dir: "workflows", cat: "workflow" },
  ];

  for (const { dir, cat } of categories) {
    const catDir = join(PROMPTS_DIR, dir);
    if (!existsSync(catDir)) continue;
    const files = readdirSync(catDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      discovered.push({
        id: `${cat}/${file.replace(/\.md$/, "")}`,
        category: cat,
        name: file.replace(/\.md$/, ""),
        description: "",
        keywords: [],
        file: `${dir}/${file}`,
      });
    }
  }

  return discovered;
}

export const ALL_PROMPTS = discoverPrompts();

export const CORE_PROMPT_IDS = ["core/system", "core/discovery", "core/behavior", "core/quality", "core/output"];

export function getPrompt(id: string): string | null {
  return loadPromptFile(id.replace(/^core\//, "core/").replace(/^capability\//, "capabilities/").replace(/^workflow\//, "workflows/") + ".md");
}

export function getCorePrompts(): string[] {
  return CORE_PROMPT_IDS.map((id) => getPrompt(id)).filter((p): p is string => p != null);
}

export function composeSystemPrompt(includeCore: boolean = true, capabilityIds: string[] = [], workflowIds: string[] = []): string {
  const parts: string[] = [];
  if (includeCore) parts.push(...getCorePrompts());
  for (const id of capabilityIds) {
    const p = getPrompt(id);
    if (p) parts.push(p);
  }
  for (const id of workflowIds) {
    const p = getPrompt(id);
    if (p) parts.push(p);
  }
  return parts.join("\n\n---\n\n");
}

const TASK_CATEGORY_KEYWORDS: Record<string, string[]> = {
  frontend: ["react", "vue", "angular", "css", "html", "tailwind", "component", "ui", "frontend", "website", "design"],
  backend: ["api", "server", "database", "sql", "express", "nest", "rest", "graphql", "backend"],
  coding: ["write code", "implement", "function", "class", "module", "typescript", "javascript", "python", "go", "rust"],
  research: ["research", "investigate", "find", "look up", "search for", "what is", "how does"],
  analysis: ["analyze", "review", "assess", "evaluate", "audit", "inspect"],
  documentation: ["document", "docs", "explain", "comment", "write a guide"],
  debugging: ["bug", "error", "fix", "broken", "issue", "exception", "stack trace"],
  testing: ["test", "spec", "unit test", "integration test", "e2e"],
  architecture: ["architecture", "design", "structure", "pattern", "system design"],
  security: ["security", "vulnerability", "xss", "injection", "auth", "permission"],
  image: ["image", "picture", "photo", "visual", "draw", "render", "generate an image"],
  infrastructure: ["infrastructure", "server", "host", "pm2", "docker", "container", "systemd", "service", "nginx", "deploy", "health", "monitor", "audit", "uptime", "load", "ram", "memory", "disk", "bottleneck", "resource", "apt", "update", "log", "journal", "systemctl"],
};

export function detectTaskCategories(task: string): string[] {
  const lower = task.toLowerCase();
  return Object.entries(TASK_CATEGORY_KEYWORDS)
    .filter(([, keywords]) => keywords.some((kw) => lower.includes(kw.toLowerCase())))
    .map(([cat]) => cat);
}

export function getCapabilityPromptIds(task: string): string[] {
  return detectTaskCategories(task).map((c) => `capability/${c}`);
}

export function getWorkflowForTask(task: string): string | null {
  const lower = task.toLowerCase();
  if (lower.includes("infrastructure") || lower.includes("server audit") || lower.includes("system audit") || lower.includes("health check") || lower.includes("host audit")) return "workflow/infrastructure-audit";
  if (lower.includes("build") || lower.includes("create") || lower.includes("make") || lower.includes("implement") || lower.includes("develop")) return "workflow/build-application";
  if (lower.includes("debug") || lower.includes("fix") || lower.includes("error") || lower.includes("bug") || lower.includes("broken")) return "workflow/debug-application";
  if (lower.includes("research") || lower.includes("investigate")) return "workflow/deep-research";
  if (lower.includes("image") || lower.includes("picture") || lower.includes("photo") || lower.includes("draw") || lower.includes("render") || lower.includes("visual")) return "workflow/generate-image";
  if (lower.includes("analyze") || lower.includes("review") || lower.includes("audit") || lower.includes("assess")) return "workflow/analyze-project";
  return "workflow/modify-application";
}

const FALLBACK_SYSTEM_PROMPT = `You are an AI coding assistant working inside a Docker workspace. You have access to tools for reading, writing, and editing files, running shell commands, and searching code.

When given a task, break it into clear steps. Read existing code before modifying it. Write clean, well-structured code. Test your changes when possible. If something is unclear, ask clarifying questions.

Always:
- Use the tools available to you (file read/write, shell commands, search)
- Follow the conventions of the existing codebase
- Explain what you're doing and why
- Verify your work compiles or runs correctly`;

export function buildSystemPromptForTask(task: string): { systemPrompt: string; promptIds: string[] } {
  const capabilityIds = getCapabilityPromptIds(task);
  const workflowId = getWorkflowForTask(task);
  const promptIds = [...capabilityIds];
  if (workflowId) promptIds.push(workflowId);
  const systemPrompt = composeSystemPrompt(true, capabilityIds, workflowId ? [workflowId] : []);
  // If the modular system is unavailable (missing files/dir), use the built-in fallback
  // instead of returning an empty string that triggers the legacy monolithic prompt.
  if (!systemPrompt) {
    warnIfMissing();
    return { systemPrompt: FALLBACK_SYSTEM_PROMPT, promptIds: [] };
  }
  return { systemPrompt, promptIds };
}