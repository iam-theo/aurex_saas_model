import { Router } from "express";
import { prisma } from "@aurex/db";
import { modelCapabilities } from "@aurex/shared";
import {
  AUREXTRA_MODELS,
  AUTO_MODEL_ID,
  CATEGORY_INFO,
  DEFAULT_MODEL_PER_CATEGORY,
  type ModelCategory,
  type AureXtraModel,
} from "@aurex/shared";
import { DEFAULT_MODEL } from "../config.js";

const router = Router();

const OPENCODE_MODELS = [
  { provider: "opencode", model: DEFAULT_MODEL, label: "Aurex BigPickle", builtin: true, local: false },
  { provider: "opencode", model: "opencode/deepseek-v4-flash-free", label: "Aurex Deepseek", builtin: true, local: false },
  { provider: "opencode", model: "opencode/laguna-s-2.1-free", label: "Aurex Laguna S2.1", builtin: true, local: false },
  { provider: "opencode", model: "opencode/kimi-k2.5-free", label: "Aurex Kimi K2.5 (vision)", builtin: true, local: false },
  { provider: "opencode", model: "opencode/qwen3.6-plus-free", label: "Aurex Qwen 3.6 (vision)", builtin: true, local: false },
  { provider: "opencode", model: "opencode/mimo-v2.5-free", label: "Aurex MiMo V2.5 (vision)", builtin: true, local: false },
  { provider: "opencode", model: "opencode/minimax-m3-free", label: "Aurex MiniMax M3 (vision)", builtin: true, local: false },
];

function aureXtraToModelInfo(model: AureXtraModel) {
  // ids that already carry a provider (e.g. "opencode/x-preview-f-free") are
  // native opencode API models; everything else is reached via OpenRouter.
  const isOpencode = model.id.startsWith("opencode/");
  const id = isOpencode ? model.id : `openrouter/${model.id}`;
  const caps = modelCapabilities(id);
  return {
    id,
    provider: isOpencode ? "opencode" : "openrouter",
    label: model.name,
    builtin: true,
    local: false,
    isDefault: false,
    image: caps.image,
    pdf: caps.pdf,
    category: model.category,
    contextLength: model.contextLength,
    modality: model.modality,
    description: model.description,
  };
}

// GET /models
router.get("/", async (_req, res, next) => {
  try {
    const configured = await prisma.modelConfig.findMany({
      where: { enabled: true },
      orderBy: { isDefault: "desc" },
    });

    const opencodeModels = OPENCODE_MODELS.map((m, i) => {
      const caps = modelCapabilities(m.model);
      return { ...m, id: m.model, isDefault: i === 0, image: caps.image, pdf: caps.pdf };
    });

    const aurextraModels = AUREXTRA_MODELS.map(aureXtraToModelInfo);

    const customModels = configured.map((c) => {
      const caps = modelCapabilities(c.model);
      return {
        id: c.model,
        provider: c.provider,
        label: c.label ?? c.model,
        builtin: false,
        local: false,
        isDefault: c.isDefault,
        image: caps.image,
        pdf: caps.pdf,
      };
    });

    res.json({
      opencode: opencodeModels,
      aurextra: aurextraModels,
      custom: customModels,
      categories: CATEGORY_INFO,
      defaultPerCategory: DEFAULT_MODEL_PER_CATEGORY,
      autoModelId: AUTO_MODEL_ID,
    });
  } catch (e) {
    next(e);
  }
});

// GET /models/categories
router.get("/categories", (_req, res) => {
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

  res.json({
    categories: CATEGORY_INFO,
    models: categories,
    defaults: DEFAULT_MODEL_PER_CATEGORY,
  });
});

export default router;
