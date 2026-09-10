import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IMPORT_LIMITS,
  ImportLimitError,
  assertWithinLimits,
  agentContextBlock,
  detectProject,
  sanitizeImportPath,
  stripCommonRoot,
} from "../src/index.js";

describe("sanitizeImportPath", () => {
  it("keeps ordinary relative paths", () => {
    assert.equal(sanitizeImportPath("src/app.ts"), "src/app.ts");
    assert.equal(sanitizeImportPath("a/b/c/deep/file.name.txt"), "a/b/c/deep/file.name.txt");
  });

  it("normalizes separators and collapses duplicates", () => {
    assert.equal(sanitizeImportPath("src\\app.ts"), "src/app.ts");
    assert.equal(sanitizeImportPath("src//double///slash.ts"), "src/double/slash.ts");
    assert.equal(sanitizeImportPath("/leading/slash.ts"), "leading/slash.ts");
  });

  it("rejects Windows drive-letter components outright", () => {
    assert.equal(sanitizeImportPath("C:\\Users\\x\\file.ts"), null);
    assert.equal(sanitizeImportPath("D:/data/file.ts"), null);
  });

  it("rejects dot segments anywhere (caller sends clean paths)", () => {
    assert.equal(sanitizeImportPath("../escape.ts"), null);
    assert.equal(sanitizeImportPath("a/../../escape.ts"), null);
    assert.equal(sanitizeImportPath("..\\..\\win-escape.ts"), null);
    // Interior "." and ".." are rejected too, not silently resolved.
    assert.equal(sanitizeImportPath("./a/b.ts"), null);
    assert.equal(sanitizeImportPath("a/./b.ts"), null);
    assert.equal(sanitizeImportPath("a/../b.ts"), null);
  });

  it("rejects empty and dot-only results", () => {
    assert.equal(sanitizeImportPath(""), null);
    assert.equal(sanitizeImportPath("."), null);
    assert.equal(sanitizeImportPath("/"), null);
    assert.equal(sanitizeImportPath("..."), null);
    assert.equal(sanitizeImportPath(".../hidden"), null);
  });

  it("rejects control characters", () => {
    assert.equal(sanitizeImportPath("bad\nname.ts"), null);
    assert.equal(sanitizeImportPath("bad\u0000name.ts"), null);
  });

  it("rejects over-long paths and excessive depth", () => {
    const deep =
      Array.from({ length: IMPORT_LIMITS.MAX_PATH_DEPTH + 1 }, (_, i) => `d${i}`).join("/") + "/f.ts";
    assert.equal(deep.length < IMPORT_LIMITS.MAX_PATH_LENGTH, true);
    assert.equal(sanitizeImportPath(deep), null);
    assert.equal(sanitizeImportPath(`${"a".repeat(IMPORT_LIMITS.MAX_PATH_LENGTH)}.ts`), null);
  });
});

describe("stripCommonRoot", () => {
  it("strips the single common top-level directory", () => {
    const r = stripCommonRoot(["myproj/src/a.ts", "myproj/src/b.ts", "myproj/package.json"]);
    assert.deepEqual(r.paths, ["src/a.ts", "src/b.ts", "package.json"]);
    assert.equal(r.root, "myproj");
  });

  it("keeps paths untouched when there is no single common root", () => {
    const paths = ["a/x.ts", "b/y.ts"];
    const r = stripCommonRoot(paths);
    assert.deepEqual(r.paths, paths);
    assert.equal(r.root, null);
  });

  it("does not strip when loose top-level files are mixed in", () => {
    const paths = ["pkg/a.ts", "b.ts"];
    const r = stripCommonRoot(paths);
    assert.deepEqual(r.paths, paths);
    assert.equal(r.root, null);
  });
});

describe("assertWithinLimits", () => {
  it("passes within limits", () => {
    assert.doesNotThrow(() => assertWithinLimits({ fileCount: 10, totalBytes: 1000 }));
  });

  it("throws on too many files / too many bytes", () => {
    assert.throws(
      () => assertWithinLimits({ fileCount: IMPORT_LIMITS.MAX_FILES + 1, totalBytes: 0 }),
      ImportLimitError,
    );
    assert.throws(
      () => assertWithinLimits({ fileCount: 0, totalBytes: IMPORT_LIMITS.MAX_FOLDER_BYTES + 1 }),
      ImportLimitError,
    );
  });
});

describe("detectProject", () => {
  const read = async (p: string) =>
    p === "package.json"
      ? JSON.stringify({
          name: "demo",
          scripts: { build: "tsc -p .", test: "vitest run", dev: "vite" },
          devDependencies: { vite: "^5.0.0", vitest: "^2.0.0", typescript: "^5.6.0" },
        })
      : null;

  it("detects a Node project from package.json + lockfile", async () => {
    const d = await detectProject(["package.json", "pnpm-lock.yaml", "src/main.ts"], read);
    assert.equal(d.language, "TypeScript");
    assert.equal(d.packageManager, "pnpm");
    assert.equal(d.testFramework, "Vitest");
    assert.equal(d.runtime, "Node.js");
    assert.equal(d.commands.install, "pnpm install");
    assert.equal(d.commands.build, "npm run build");
    assert.equal(d.commands.test, "pnpm test");
    assert.deepEqual(d.entryPoints, ["src/main.ts"]);
  });

  it("detects framework deps in priority order", async () => {
    const d = await detectProject(
      ["package.json"],
      async (p) =>
        p === "package.json"
          ? JSON.stringify({ dependencies: { next: "13.0.0", react: "18.0.0" } })
          : null,
    );
    assert.equal(d.framework, "Next.js");
  });

  it("detects Python from requirements.txt including frameworks", async () => {
    const d = await detectProject(["requirements.txt", "app.py"], async (p) =>
      p === "requirements.txt" ? "django==5.0\npytest\n" : null,
    );
    assert.equal(d.language, "Python");
    assert.equal(d.framework, "Django");
    assert.equal(d.packageManager, "pip");
    assert.equal(d.commands.install, "pip install -r requirements.txt");
    assert.deepEqual(d.entryPoints, ["app.py"]);
  });

  it("falls back to a language census for unknown stacks", async () => {
    const d = await detectProject(["random.bin", "lib.rs"], async () => null);
    assert.equal(d.language, "Rust");
    assert.deepEqual(d.languages, ["Rust"]);
    assert.equal(Object.keys(d.commands).length, 0);
  });
});

describe("agentContextBlock", () => {
  it("mentions the project name, directory and detected commands", () => {
    const block = agentContextBlock("Demo App", {
      languages: ["TypeScript"],
      language: "TypeScript",
      entryPoints: ["src/main.ts"],
      commands: { build: "npm run build" },
    }, "/workspace/demo-app");
    assert.match(block, /Demo App/);
    assert.match(block, /\/workspace\/demo-app/);
    assert.match(block, /npm run build/);
    assert.match(block, /EXISTING codebase/);
  });
});
