/**
 * AureXtra free models registry with categorization.
 * Models organized by use case for the agent execution platform.
 * All models have $0 pricing for prompt and completion.
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
    id: "poolside/laguna-s-2.1:free",
    name: "Laguna S 2.1",
    category: "coding",
    contextLength: 262144,
    modality: "text->text",
    inputModalities: ["text"],
    description: "High-quality code generation model",
  },
  {
    id: "poolside/laguna-xs-2.1:free",
    name: "Laguna XS 2.1",
    category: "coding",
    contextLength: 262144,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Lightweight code generation model",
  },
  {
    id: "cohere/north-mini-code:free",
    name: "North Mini Code",
    category: "coding",
    contextLength: 256000,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Specialized code generation and analysis",
  },
  {
    id: "z-ai/glm-5.2:free",
    name: "GLM 5.2",
    category: "coding",
    contextLength: 256000,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Advanced code understanding and generation",
  },
  {
    // Served by the opencode API itself (not OpenRouter): `opencode models` lists x-preview-f-free
    id: "opencode/x-preview-f-free",
    name: "Ox Alpha",
    category: "coding",
    contextLength: 131072,
    modality: "text->text",
    inputModalities: ["text"],
    description: "High-performance coding assistant with strong reasoning",
  },

  // === REASONING / ORCHESTRATION ===
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    name: "Nemotron 3 Ultra",
    category: "reasoning",
    contextLength: 1000000,
    modality: "text->text",
    inputModalities: ["text"],
    description: "550B parameter model for complex reasoning tasks",
  },
  {
    id: "dots-studio/dots-3-note-preview:free",
    name: "Dots3-Note Preview",
    category: "reasoning",
    contextLength: 512000,
    modality: "text+image->text",
    inputModalities: ["text", "image"],
    description: "Note-taking with reasoning capabilities",
  },
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    name: "Nemotron 3.5 Lightning",
    category: "reasoning",
    contextLength: 1000000,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Fast reasoning with 1M context window",
  },

  // === MULTIMODAL / PERCEPTION ===
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    name: "Nemotron 3 Nano Omni",
    category: "multimodal",
    contextLength: 256000,
    modality: "text+image+audio+video->text",
    inputModalities: ["text", "image", "audio", "video"],
    description: "True multimodal: text, image, audio, and video",
  },

  // === RAG / RETRIEVAL ===
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    name: "Nemotron 3 Super",
    category: "rag",
    contextLength: 262144,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Strong retrieval and context understanding",
  },

  // === SAFETY / GUARDRAILS ===
  {
    id: "nvidia/nemotron-3.5-content-safety:free",
    name: "Nemotron 3.5 Content Safety",
    category: "safety",
    contextLength: 128000,
    modality: "text+image->text",
    inputModalities: ["text", "image"],
    description: "Content safety classification and filtering",
  },

  // === AUDIO / VISION ===
  {
    id: "nvidia/nemotron-nano-12b-v2-vl:free",
    name: "Nemotron Nano 12B VL",
    category: "audio",
    contextLength: 128000,
    modality: "text+image+video->text",
    inputModalities: ["text", "image", "video"],
    description: "Vision-language model with video understanding",
  },

  // === LIGHTWEIGHT / EXTRACTION ===
  {
    id: "liquid/lfm-2.5-2.6b:free",
    name: "LFM2.5-2.6B",
    category: "lightweight",
    contextLength: 128000,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Ultra-fast 2.6B parameter model for extraction",
  },
  {
    id: "nvidia/nemotron-nano-9b-v2:free",
    name: "Nemotron Nano 9B V2",
    category: "lightweight",
    contextLength: 128000,
    modality: "text->text",
    inputModalities: ["text"],
    description: "Fast 9B model for quick tasks",
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
    description: "Text, image, audio, and video understanding",
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
  coding: "opencode/x-preview-f-free",
  reasoning: "nvidia/nemotron-3-ultra-550b-a55b:free",
  multimodal: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  rag: "nvidia/nemotron-3-super-120b-a12b:free",
  safety: "nvidia/nemotron-3.5-content-safety:free",
  audio: "nvidia/nemotron-nano-12b-v2-vl:free",
  lightweight: "liquid/lfm-2.5-2.6b:free",
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
