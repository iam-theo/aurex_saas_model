/**
 * AureXtra free models registry with categorization.
 * Models organized by use case for the agent execution platform.
 * All models are served natively by the opencode API.
 */

export type ModelCategory =
  | "coding"
  | "reasoning"
  | "multimodal"
  | "rag"
  | "safety"
  | "audio"
  | "lightweight";

export interface AureXtraModel {
  id: string;
  name: string;
  category: ModelCategory;
  contextLength: number;
  modality: string;
  inputModalities: string[];
  description: string;
}

export const AUREXTRA_MODELS: AureXtraModel[] = [
  // === CODING AGENTS ===
  {
    id: "opencode/deepseek-v4-flash-free",
    name: "Deepseek V4 Flash",
    category: "coding",
    contextLength: 131072,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Fast, high-quality code generation and analysis",
  },
  {
    id: "opencode/laguna-s-2.1-free",
    name: "Laguna S 2.1",
    category: "coding",
    contextLength: 262144,
    modality: "text->text",
    inputModalities: ["text"],
    description: "High-quality code generation model",
  },

  // === REASONING / ORCHESTRATION ===
  {
    id: "opencode/big-pickle",
    name: "BigPickle",
    category: "reasoning",
    contextLength: 131072,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Flagship model for complex reasoning and orchestration",
  },

  // === MULTIMODAL / PERCEPTION ===
  {
    id: "opencode/kimi-k2.5-free",
    name: "Kimi K2.5",
    category: "multimodal",
    contextLength: 131072,
    modality: "text+image->text",
    inputModalities: ["text", "image"],
    description: "Vision-language model with strong reasoning",
  },
  {
    id: "opencode/qwen3.6-plus-free",
    name: "Qwen 3.6 Plus",
    category: "multimodal",
    contextLength: 131072,
    modality: "text+image->text",
    inputModalities: ["text", "image"],
    description: "Vision-language model with broad knowledge",
  },
  {
    id: "opencode/mimo-v2.5-free",
    name: "MiMo V2.5",
    category: "multimodal",
    contextLength: 131072,
    modality: "text+image->text",
    inputModalities: ["text", "image"],
    description: "Vision-language model for image understanding",
  },
  {
    id: "opencode/minimax-m3-free",
    name: "MiniMax M3",
    category: "multimodal",
    contextLength: 131072,
    modality: "text+image->text",
    inputModalities: ["text", "image"],
    description: "Vision-language model with multimodal understanding",
  },
];

export function getModelsByCategory(category: ModelCategory): AureXtraModel[] {
  return AUREXTRA_MODELS.filter((m) => m.category === category);
}

export function getModelById(id: string): AureXtraModel | undefined {
  return AUREXTRA_MODELS.find((m) => m.id === id);
}

export function getModelsByCategories(): Record<ModelCategory, AureXtraModel[]> {
  const categories: Record<ModelCategory, AureXtraModel[]> = {
    coding: [],
    reasoning: [],
    multimodal: [],
    rag: [],
    safety: [],
    audio: [],
    lightweight: [],
  };
  for (const model of AUREXTRA_MODELS) {
    categories[model.category].push(model);
  }
  return categories;
}

export const CATEGORY_INFO: Record<ModelCategory, { label: string; description: string; icon: string }> = {
  coding: {
    label: "Coding Agents",
    description: "Code generation, debugging, and analysis",
    icon: "code",
  },
  reasoning: {
    label: "Reasoning",
    description: "Complex reasoning and multi-step orchestration",
    icon: "psychology",
  },
  multimodal: {
    label: "Multimodal",
    description: "Text, image, and visual understanding",
    icon: "devices",
  },
  rag: {
    label: "RAG",
    description: "Retrieval-augmented generation and context understanding",
    icon: "search",
  },
  safety: {
    label: "Safety",
    description: "Content safety and filtering",
    icon: "shield",
  },
  audio: {
    label: "Vision",
    description: "Visual perception and video analysis",
    icon: "visibility",
  },
  lightweight: {
    label: "Lightweight",
    description: "Fast models for extraction and quick tasks",
    icon: "bolt",
  },
};

export const DEFAULT_MODEL_PER_CATEGORY: Record<ModelCategory, string> = {
  coding: "opencode/deepseek-v4-flash-free",
  reasoning: "opencode/big-pickle",
  multimodal: "opencode/kimi-k2.5-free",
  rag: "opencode/big-pickle",
  safety: "opencode/big-pickle",
  audio: "opencode/minimax-m3-free",
  lightweight: "opencode/deepseek-v4-flash-free",
};

export const CATEGORY_PRIORITY: ModelCategory[] = [
  "coding",
  "reasoning",
  "multimodal",
  "rag",
  "safety",
  "audio",
  "lightweight",
];

// ─── Auto-Selection Engine ───────────────────────────────────────────────────

/** Signals in task text that map to a category for auto-selection. */
const CATEGORY_SIGNALS: [ModelCategory, RegExp][] = [
  ["coding", /\b(code|codes?|coding|program|programming|function|functions?|class|classes?|method|methods?|api|apis?|debug|debugging|fix\s+bug|bug\s+fix|refactor|implement|build|compile|typescript|javascript|python|rust|golang|html|css|sql|react|vue|angular|node\.?js|npm|pip|cargo|git|docker|deploy|test|tests?|lint|eslint|prettier|webpack|vite|prisma|schema|migration|endpoint|routes?|controller|middleware|import|export|variable|const|let|var|async|await|promise|callback|interface|type|enum|struct|component|hook|state|props|render)\b/i],
  ["reasoning", /\b(analyze|analysis|explain|explanation|reason|reasoning|compare|contrast|evaluate|evaluate|pros?\s*and\s*cons?|strategy|strategic|plan|planning|architect|architecture|design|decide|decision|trade-?off|logic|logical|deduce|deduction|induce|induction|step-?by-?step|chain\s+of\s+thought|think|thinking|reflect|reflection|orchestrat|orchestr)\b/i],
  ["rag", /\b(search|retrieve|retrieval|find|lookup|document|documents?|knowledge|base|embed|index|chunk|relevan|context|summar|summary|summarize|qa|question\s*answer|faq|ingest|parse|extract\s+from|pdf|doc|markdown|text\s+file|read\s+file|concat|concatenat)\b/i],
  ["multimodal", /\b(image|images?|photo|photos?|picture|pictures?|screenshot|screenshots?|video|videos?|audio|audio|voice|speech|transcribe|transcription|ocr|see|visual|diagram|chart|graph|draw|sketch|diagnos|medical|scan)\b/i],
  ["safety", /\b(safe|safety|safe-?guard|content\s*policy|moderat|moderation|toxic|harmful|inappropriate|filter|block|nsfw|pg-?13|compli|compliance|violat|policy|guideline|trust|trustworth|harm|damage|risk|danger)\b/i],
  ["audio", /\b(see|look|watch|view|watching|visual|visuals|display|show|present|video|camera|detect|recog|recogni|object|face|scene|percept|optic|pixel|frame|render)\b/i],
  ["lightweight", /\b(fast|quick|simple|easy|short|brief|small|concise|tldr|tl;dr|bullet|bullets?|one-liner|oneliner|snippet|trivial|minimal|light|quickly|asap|急|hurry)\b/i],
];

/**
 * Auto-select the best AureXtra model for a given task prompt.
 * Analyzes the task text for category signals and picks the default
 * model from the strongest matching category. Falls back to reasoning
 * (general-purpose) when no strong signal is found.
 */
export function autoSelectModel(task: string): { model: string; category: ModelCategory; confidence: number } {
  const scores: Record<ModelCategory, number> = {
    coding: 0,
    reasoning: 0,
    multimodal: 0,
    rag: 0,
    safety: 0,
    audio: 0,
    lightweight: 0,
  };

  for (const [category, regex] of CATEGORY_SIGNALS) {
    const matches = task.match(regex);
    if (matches) {
      scores[category] += matches.length;
    }
  }

  // Boost reasoning as a baseline (it handles general tasks well)
  scores.reasoning += 1;

  let bestCategory: ModelCategory = "reasoning";
  let bestScore = 0;
  for (const cat of CATEGORY_PRIORITY) {
    if (scores[cat] > bestScore) {
      bestScore = scores[cat];
      bestCategory = cat;
    }
  }

  const model = DEFAULT_MODEL_PER_CATEGORY[bestCategory];
  const confidence = bestScore > 0 ? Math.min(bestScore / 5, 1) : 0.3;

  return { model, category: bestCategory, confidence };
}

/**
 * The special "auto" model ID used to trigger automatic model selection.
 */
export const AUTO_MODEL_ID = "aurextra/auto";