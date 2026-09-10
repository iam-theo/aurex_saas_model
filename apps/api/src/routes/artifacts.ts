// Artifact API routes — serve generated artifacts (images, etc.)
import { Router } from "express";
import { prisma } from "@aurex/db";
import { assertProjectAccess } from "../access.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const IMAGE_STORAGE_DIR = process.env.IMAGE_STORAGE_DIR ?? "/tmp/aurex-artifacts";

const router = Router();

// List artifacts for a project
router.get("/:projectId/artifacts", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.projectId))) return;
    const artifacts = await prisma.artifact.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(artifacts);
  } catch (e) {
    next(e);
  }
});

// Get a single artifact
router.get("/:projectId/artifacts/:artifactId", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.projectId))) return;
    const artifact = await prisma.artifact.findFirst({
      where: { id: req.params.artifactId, projectId: req.params.projectId },
    });
    if (!artifact) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }
    res.json(artifact);
  } catch (e) {
    next(e);
  }
});

// Serve artifact file (image preview/download)
router.get("/:projectId/artifacts/:artifactId/file", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.projectId))) return;
    const artifact = await prisma.artifact.findFirst({
      where: { id: req.params.artifactId, projectId: req.params.projectId },
    });
    if (!artifact) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }
    if (artifact.status !== "completed" || !artifact.storageKey) {
      res.status(400).json({ error: "artifact not ready" });
      return;
    }

    const filePath = path.join(IMAGE_STORAGE_DIR, artifact.storageKey);
    try {
      await fs.access(filePath);
    } catch {
      res.status(404).json({ error: "artifact file not found" });
      return;
    }

    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", artifact.mimeType);
    res.setHeader("Content-Disposition", `${disposition}; filename="${artifact.filename}"`);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const stream = (await import("node:fs")).createReadStream(filePath);
    stream.pipe(res);
  } catch (e) {
    next(e);
  }
});

// Delete an artifact
router.delete("/:projectId/artifacts/:artifactId", async (req, res, next) => {
  try {
    if (!(await assertProjectAccess(req, res, req.params.projectId))) return;
    const artifact = await prisma.artifact.findFirst({
      where: { id: req.params.artifactId, projectId: req.params.projectId },
    });
    if (!artifact) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }

    // Delete file from disk
    if (artifact.storageKey) {
      const filePath = path.join(IMAGE_STORAGE_DIR, artifact.storageKey);
      await fs.unlink(filePath).catch(() => undefined);
    }

    await prisma.artifact.delete({ where: { id: artifact.id } });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
