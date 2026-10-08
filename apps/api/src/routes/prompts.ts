import { Router } from "express";
import { ALL_PROMPTS, getPrompt, type PromptMeta } from "@aurex/shared/prompts";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ prompts: ALL_PROMPTS });
});

router.get("/:id", (req, res) => {
  const { id } = req.params;
  const meta = ALL_PROMPTS.find((p) => p.id === id);
  if (!meta) {
    res.status(404).json({ error: "prompt not found" });
    return;
  }
  const content = getPrompt(id);
  if (content === null) {
    res.status(404).json({ error: "prompt file not found" });
    return;
  }
  res.json({ id, meta, content });
});

router.get("/:id/content", (req, res) => {
  const { id } = req.params;
  const content = getPrompt(id);
  if (content === null) {
    res.status(404).json({ error: "prompt not found" });
    return;
  }
  res.type("text/markdown").send(content);
});

export default router;
