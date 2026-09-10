/**
 * Technology detection for imported projects.
 *
 * Pure and extensible: a registry of detectors keyed by well-known manifests.
 * Each detector receives the manifest content plus the full relative file
 * listing and returns partial findings; results are merged into a single
 * DetectedProject. Adding support for a new stack means appending one entry to
 * DETECTORS — no other changes required.
 */

export interface DetectedCommands {
  install?: string;
  build?: string;
  test?: string;
  dev?: string;
}

export interface DetectedProject {
  language?: string;
  languages: string[];
  framework?: string;
  runtime?: string;
  packageManager?: string;
  buildSystem?: string;
  testFramework?: string;
  entryPoints: string[];
  commands: DetectedCommands;
}

export type ManifestReader = (path: string) => Promise<string | null>;

interface DetectContext {
  files: string[];
  has: (path: string) => boolean;
  readManifest: ManifestReader;
}

type Detector = {
  /** Manifest files this detector consumes. Read lazily, only when present. */
  manifests: string[];
  detect: (contents: Record<string, string>, ctx: DetectContext) => Partial<DetectedProject> | null;
};

const FRAMEWORK_DEPS: Array<{ dep: string; framework: string }> = [
  { dep: "next", framework: "Next.js" },
  { dep: "nuxt", framework: "Nuxt" },
  { dep: "@remix-run/node", framework: "Remix" },
  { dep: "react", framework: "React" },
  { dep: "react-native", framework: "React Native" },
  { dep: "vue", framework: "Vue" },
  { dep: "@angular/core", framework: "Angular" },
  { dep: "svelte", framework: "Svelte" },
  { dep: "@nestjs/core", framework: "NestJS" },
  { dep: "express", framework: "Express" },
  { dep: "fastify", framework: "Fastify" },
  { dep: "astro", framework: "Astro" },
  { dep: "@docusaurus/core", framework: "Docusaurus" },
  { dep: "electron", framework: "Electron" },
];

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function scriptsOf(pkg: Record<string, unknown>): Record<string, string> {
  const s = pkg.scripts;
  if (!s || typeof s !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function firstExisting(files: string[], candidates: string[]): string[] {
  const set = new Set(files);
  return candidates.filter((c) => set.has(c));
}

/** Extension census fallback when no manifest exists. */
const EXT_LANGUAGE: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  swift: "Swift",
  dart: "Dart",
  ex: "Elixir",
  scala: "Scala",
};

function languagesFromCensus(files: string[]): Array<{ language: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const base = f.split("/").pop() ?? f;
    const dot = base.lastIndexOf(".");
    if (dot === -1 || dot === base.length - 1) continue;
    const lang = EXT_LANGUAGE[base.slice(dot + 1).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);
}

const NODE_ENTRY_CANDIDATES = [
  "src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx",
  "src/index.js", "src/main.js", "src/server.js", "src/app.js",
  "index.ts", "index.js", "main.js", "server.js", "app.js",
  "src/pages/index.tsx", "app/page.tsx", "app/layout.tsx",
];

export const DETECTORS: Detector[] = [
  {
    // Node / JS-TS ecosystem. Lockfiles decide the package manager.
    manifests: ["package.json"],
    detect: (m, ctx) => {
      const pkg = parseJson(m["package.json"] ?? "");
      if (!pkg) return null;
      const deps = {
        ...((pkg.dependencies as Record<string, unknown>) ?? {}),
        ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
      };
      const scripts = scriptsOf(pkg);
      const out: Partial<DetectedProject> = {};

      out.language = ctx.has("tsconfig.json") || Object.keys(deps).some((d) => d.startsWith("typescript"))
        ? "TypeScript"
        : "JavaScript";
      out.runtime = (() => {
        const engines = pkg.engines as Record<string, string> | undefined;
        if (engines && typeof engines.node === "string") return `Node.js ${engines.node.replace(/^[\^~>=<\s]+/, "")}`;
        return "Node.js";
      })();

      for (const { dep, framework } of FRAMEWORK_DEPS) {
        if (deps[dep] !== undefined) {
          out.framework = framework;
          break;
        }
      }

      out.packageManager = ctx.has("pnpm-lock.yaml")
        ? "pnpm"
        : ctx.has("yarn.lock")
          ? "yarn"
          : ctx.has("bun.lockb") || ctx.has("bun.lock")
            ? "bun"
            : ctx.has("package-lock.json")
              ? "npm"
              : undefined;

      const pmRun = (script: string) =>
        out.packageManager === "bun" ? `bun run ${script}` :
        out.packageManager === "pnpm" ? `pnpm ${script}` :
        out.packageManager === "yarn" ? `yarn ${script}` :
        `npm run ${script}`;
      out.commands = {
        install: out.packageManager === "pnpm" ? "pnpm install"
          : out.packageManager === "yarn" ? "yarn install"
          : out.packageManager === "bun" ? "bun install"
          : "npm install",
        build: scripts.build ? pmRun("build") : undefined,
        test: scripts.test ? (out.packageManager === "bun" ? "bun test" : out.packageManager === "pnpm" ? "pnpm test" : out.packageManager === "yarn" ? "yarn test" : "npm test") : undefined,
        dev: scripts.dev ? pmRun("dev")
          : scripts.start ? (out.packageManager === "bun" ? "bun run start" : out.packageManager === "yarn" ? "yarn start" : "npm start") : undefined,
      };

      out.testFramework =
        deps.vitest !== undefined ? "Vitest"
        : deps.jest !== undefined ? "Jest"
        : deps.mocha !== undefined ? "Mocha"
        : deps["@playwright/test"] !== undefined ? "Playwright"
        : deps.cypress !== undefined ? "Cypress"
        : undefined;

      const main = typeof pkg.main === "string" ? pkg.main : undefined;
      const bin = typeof pkg.bin === "string" ? pkg.bin : undefined;
      out.entryPoints = [
        ...(main ? [main] : []),
        ...(bin ? [bin] : []),
        ...firstExisting(ctx.files, NODE_ENTRY_CANDIDATES),
      ].slice(0, 5);

      return out;
    },
  },
  {
    manifests: ["Cargo.toml"],
    detect: (m) => {
      const raw = m["Cargo.toml"] ?? "";
      if (!raw.trim()) return null;
      const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(raw)?.[1];
      return {
        language: "Rust",
        runtime: undefined,
        packageManager: "cargo",
        buildSystem: "Cargo",
        commands: { install: undefined, build: "cargo build", test: "cargo test", dev: "cargo run" },
        entryPoints: ["src/main.rs", "src/lib.rs"],
        ...(name ? {} : {}),
      };
    },
  },
  {
    manifests: ["go.mod"],
    detect: (m, ctx) => {
      const raw = m["go.mod"] ?? "";
      const mod = /^module\s+(\S+)/m.exec(raw);
      const goVer = /^go\s+([0-9.]+)/m.exec(raw);
      if (!mod && !raw.trim()) return null;
      const entries = firstExisting(ctx.files, ["main.go", "cmd/main.go", "src/main.go"]);
      return {
        language: "Go",
        runtime: goVer ? `Go ${goVer[1]}` : "Go",
        packageManager: "go modules",
        commands: { build: "go build ./...", test: "go test ./...", dev: "go run ." },
        entryPoints: entries.length ? entries : ctx.files.filter((f) => f === "main.go" || f.endsWith("/main.go")).slice(0, 3),
      };
    },
  },
  {
    manifests: ["pyproject.toml"],
    detect: (m, ctx) => {
      const raw = m["pyproject.toml"] ?? "";
      if (!raw.trim()) return null;
      const poetry = /\[tool\.poetry\]/.test(raw);
      const uv = /\[tool\.uv\]/.test(raw);
      const pytest = /\[tool\.pytest[.\]]/.test(raw) || ctx.has("pytest.ini") || ctx.has("conftest.py");
      return {
        language: "Python",
        packageManager: poetry ? "poetry" : uv ? "uv" : "pip",
        buildSystem: poetry ? "Poetry" : undefined,
        testFramework: pytest ? "pytest" : undefined,
        commands: {
          install: poetry ? "poetry install" : uv ? "uv sync" : "pip install -e .",
          test: pytest ? (poetry ? "poetry run pytest" : "pytest") : undefined,
          dev: undefined,
        },
        entryPoints: firstExisting(ctx.files, ["main.py", "app.py", "src/main.py", "manage.py"]),
      };
    },
  },
  {
    manifests: ["requirements.txt"],
    detect: (m, ctx) => {
      const raw = m["requirements.txt"] ?? "";
      if (!raw.trim()) return null;
      const django = /^django/im.test(raw);
      const flask = /^flask/im.test(raw);
      const fastapi = /^fastapi/im.test(raw);
      const pytest = ctx.has("pytest.ini") || ctx.has("conftest.py") || /^pytest/im.test(raw);
      return {
        language: "Python",
        packageManager: "pip",
        framework: django ? "Django" : fastapi ? "FastAPI" : flask ? "Flask" : undefined,
        testFramework: pytest ? "pytest" : undefined,
        commands: {
          install: "pip install -r requirements.txt",
          test: pytest ? "pytest" : undefined,
          dev: django ? "python manage.py runserver" : fastapi ? "uvicorn app:app --reload" : flask ? "flask run" : undefined,
        },
        entryPoints: firstExisting(ctx.files, ["manage.py", "app.py", "main.py", "wsgi.py", "run.py"]),
      };
    },
  },
  {
    manifests: ["composer.json"],
    detect: (m) => {
      const composer = parseJson(m["composer.json"] ?? "");
      if (!composer) return null;
      const req = ((composer.require as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      const laravel = req["laravel/framework"] !== undefined;
      const symfony = Object.keys(req).some((d) => d.startsWith("symfony/"));
      const phpRaw = typeof req.php === "string" ? req.php : undefined;
      return {
        language: "PHP",
        framework: laravel ? "Laravel" : symfony ? "Symfony" : undefined,
        packageManager: "composer",
        runtime: phpRaw ? `PHP ${phpRaw.replace(/^[\^~>=<\s]+/, "")}` : undefined,
        commands: { install: "composer install", test: "./vendor/bin/phpunit", dev: laravel ? "php artisan serve" : undefined },
        entryPoints: firstExisting([], ["index.php", "artisan", "public/index.php"]) as string[],
      };
    },
  },
  {
    manifests: ["pom.xml"],
    detect: (m) => {
      const raw = m["pom.xml"] ?? "";
      if (!/<project[\s>]/.test(raw)) return null;
      const javaVer = /<(maven\.compiler\.(source|target)|java\.version)>([^<]+)</.exec(raw)?.[3];
      const springBoot = /spring-boot/i.test(raw);
      return {
        language: "Java",
        framework: springBoot ? "Spring Boot" : undefined,
        buildSystem: "Maven",
        runtime: javaVer ? `Java ${javaVer}` : undefined,
        commands: { install: "mvn -q dependency:resolve", build: "mvn -q package", test: "mvn test", dev: springBoot ? "mvn spring-boot:run" : undefined },
        entryPoints: [],
      };
    },
  },
  {
    manifests: ["build.gradle.kts", "build.gradle"],
    detect: (m, ctx) => {
      const file = ctx.has("build.gradle.kts") ? "build.gradle.kts" : "build.gradle";
      const raw = m[file] ?? "";
      if (!raw.trim() && !ctx.has(file)) return null;
      const android = /com\.android\.(application|library)/.test(raw);
      const kotlin = /org\.jetbrains\.kotlin|kotlin\(/.test(raw) || ctx.has("settings.gradle.kts");
      return {
        language: kotlin ? "Kotlin" : "Java",
        buildSystem: "Gradle",
        framework: android ? "Android" : undefined,
        commands: { install: undefined, build: "./gradlew build", test: "./gradlew test", dev: "./gradlew run" },
        entryPoints: [],
      };
    },
  },
  {
    manifests: ["pubspec.yaml"],
    detect: (m) => {
      const raw = m["pubspec.yaml"] ?? "";
      if (!/^name:/m.test(raw) && !raw.trim()) return null;
      const flutter = /sdk:\s*flutter/.test(raw);
      return {
        language: "Dart",
        framework: flutter ? "Flutter" : undefined,
        packageManager: flutter ? "flutter pub" : "dart pub",
        commands: {
          install: flutter ? "flutter pub get" : "dart pub get",
          test: flutter ? "flutter test" : "dart test",
          dev: flutter ? "flutter run" : undefined,
        },
        entryPoints: firstExisting([], ["lib/main.dart", "bin/main.dart"]) as string[],
      };
    },
  },
  {
    manifests: [],
    detect: (_m, ctx) => {
      const csproj = ctx.files.find((f) => f.endsWith(".csproj"));
      const sln = ctx.files.find((f) => f.endsWith(".sln"));
      if (!csproj && !sln) return null;
      return {
        language: "C#",
        buildSystem: ".NET SDK",
        packageManager: "NuGet",
        commands: { install: "dotnet restore", build: "dotnet build", test: "dotnet test", dev: "dotnet run" },
        entryPoints: firstExisting(ctx.files, ["Program.cs", "Startup.cs"]),
      };
    },
  },
  {
    manifests: ["Gemfile"],
    detect: (m) => {
      if (!(m["Gemfile"] ?? "").trim()) return null;
      return {
        language: "Ruby",
        packageManager: "bundler",
        framework: undefined, // refined below via rails detection
        commands: { install: "bundle install", test: "bundle exec rake test", dev: "bundle exec rails server" },
        entryPoints: ["config/application.rb", "config.ru"].filter(() => true),
      };
    },
  },
  {
    manifests: ["mix.exs"],
    detect: (m) => {
      if (!(m["mix.exs"] ?? "").trim()) return null;
      return {
        language: "Elixir",
        buildSystem: "Mix",
        commands: { install: "mix deps.get", test: "mix test", dev: "iex -S mix" },
        entryPoints: ["lib/application.ex"],
      };
    },
  },
];

/**
 * Detect the technology of an imported project from its relative file listing.
 * Manifest contents are read lazily through readManifest so the caller can
 * fetch them from inside the workspace container without pulling the whole
 * codebase into memory.
 */
export async function detectProject(
  files: string[],
  readManifest: ManifestReader,
): Promise<DetectedProject> {
  const ctx: DetectContext = {
    files,
    has: (p) => new Set(files).has(p),
    readManifest,
  };

  const merged: DetectedProject = {
    languages: [],
    entryPoints: [],
    commands: {},
  };

  // Framework refinement for Ruby: rails detection needs config/ presence.
  let isRails = false;
  if (files.includes("Gemfile")) {
    isRails = files.includes("config/application.rb") || files.includes("config/routes.rb");
  }

  for (const detector of DETECTORS) {
    const present = detector.manifests.filter((mf) => ctx.has(mf));
    // Manifest-less detectors decide for themselves from the file listing.
    if (detector.manifests.length > 0 && present.length === 0) continue;
    const contents: Record<string, string> = {};
    for (const mf of present) {
      const raw = await readManifest(mf).catch(() => null);
      contents[mf] = raw ?? "";
    }
    const result = detector.detect(contents, ctx);
    if (!result) continue;
    if (result.language && !merged.language) merged.language = result.language;
    if (result.framework && !merged.framework) merged.framework = result.framework;
    if (result.runtime && !merged.runtime) merged.runtime = result.runtime;
    if (result.packageManager && !merged.packageManager) merged.packageManager = result.packageManager;
    if (result.buildSystem && !merged.buildSystem) merged.buildSystem = result.buildSystem;
    if (result.testFramework && !merged.testFramework) merged.testFramework = result.testFramework;
    if (result.entryPoints?.length && merged.entryPoints.length === 0) merged.entryPoints = result.entryPoints;
    if (result.commands) merged.commands = { ...merged.commands, ...cleanCommands(result.commands) };
  }

  if (isRails && merged.language === "Ruby") merged.framework = "Ruby on Rails";

  // Language census fills gaps and records secondary languages.
  const census = languagesFromCensus(files);
  merged.languages = census.map((c) => c.language);
  if (!merged.language && census.length > 0) merged.language = census[0].language;
  if (merged.language && !merged.languages.includes(merged.language)) {
    merged.languages.unshift(merged.language);
  }
  merged.languages = merged.languages.slice(0, 5);

  // Dockerfile / compose indicate the build system even for polyglot repos.
  if (!merged.buildSystem && (files.includes("Dockerfile") || files.includes("docker-compose.yml"))) {
    merged.buildSystem = "Docker";
  }
  if (!merged.testFramework && files.some((f) => f.includes("__tests__") || f.match(/\.(test|spec)\.[tj]sx?$/))) {
    merged.testFramework = merged.packageManager ? undefined : undefined;
  }

  return merged;
}

function cleanCommands(c: DetectedCommands): DetectedCommands {
  const out: DetectedCommands = {};
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === "string" && v.trim()) out[k as keyof DetectedCommands] = v.trim();
  }
  return out;
}

/**
 * Compact context block appended to the agent's system prompt so it knows it
 * is operating inside an existing imported codebase. Kept deliberately short:
 * the agent inspects files itself with its own tools.
 */
export function agentContextBlock(projectName: string, detected: DetectedProject, directory: string): string {
  const lines: string[] = [];
  lines.push(`## Existing Imported Project`);
  lines.push(``);
  lines.push(`You are working inside an EXISTING codebase that the user imported — not a greenfield build.`);
  lines.push(`- Project name: ${projectName}`);
  lines.push(`- Workspace location: ${directory}`);
  if (detected.language) lines.push(`- Language: ${detected.language}${detected.languages.length > 1 ? ` (${detected.languages.join(", ")})` : ""}`);
  if (detected.framework) lines.push(`- Framework: ${detected.framework}`);
  if (detected.runtime) lines.push(`- Runtime: ${detected.runtime}`);
  if (detected.packageManager) lines.push(`- Package manager: ${detected.packageManager}`);
  if (detected.buildSystem) lines.push(`- Build system: ${detected.buildSystem}`);
  if (detected.testFramework) lines.push(`- Test framework: ${detected.testFramework}`);
  if (detected.commands.install) lines.push(`- Install dependencies: \`${detected.commands.install}\``);
  if (detected.commands.build) lines.push(`- Build: \`${detected.commands.build}\``);
  if (detected.commands.test) lines.push(`- Tests: \`${detected.commands.test}\``);
  if (detected.commands.dev) lines.push(`- Run locally: \`${detected.commands.dev}\``);
  if (detected.entryPoints.length > 0) lines.push(`- Entry points: ${detected.entryPoints.join(", ")}`);
  lines.push(``);
  lines.push(`Working rules:`);
  lines.push(`1. Understand the request, then inspect the existing code with your search/read tools before changing anything.`);
  lines.push(`2. Respect the existing architecture, conventions and file layout. Make focused changes.`);
  lines.push(`3. Never rewrite working code unnecessarily.`);
  lines.push(`4. After changes: install dependencies if needed, then run the tests/build listed above and fix any issues you introduced.`);
  lines.push(`5. Report exactly what you changed and why.`);
  return lines.join("\n");
}
