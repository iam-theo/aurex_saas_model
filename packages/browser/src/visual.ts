/**
 * Visual analysis architecture (Phase 11) + visual regression (Phase 12).
 *
 * Provider-agnostic interfaces for vision-capable analysis and screenshot
 * comparison. The first implementation ships a structural/comparative
 * analyzer that works purely on metadata + screenshot hashes, so it can run
 * without any external vision model. A future vision-based `VisualAnalyzer`
 * implementation can be plugged in by implementing the same interface.
 */

export interface VisualFinding {
  severity: "high" | "medium" | "low";
  category: "layout" | "content" | "color" | "functional" | "other";
  description: string;
  evidence?: string;
  suggestedFiles?: string[];
  suggestedFix?: string;
}

export interface VisualAnalysisInput {
  screenshotPath?: string;
  screenshot?: { data: string; width: number; height: number };
  dom?: string;
  console?: unknown[];
  network?: unknown[];
  sourceContext?: string;
}

export interface VisualAnalysisResult {
  findings: VisualFinding[];
  /** Structured description of the screenshot for downstream reasoning. */
  description: string;
  metadata: Record<string, unknown>;
}

export interface CompareResult {
  identical: boolean;
  diffRatio: number;
  diffPixels: number;
  totalPixels: number;
  notes?: string;
}

/** Contract every visual analyzer must satisfy. */
export interface VisualAnalyzer {
  readonly name: string;
  analyzeScreenshot(input: VisualAnalysisInput): Promise<VisualAnalysisResult>;
  compareScreenshots(baseline: VisualAnalysisInput, current: VisualAnalysisInput): Promise<CompareResult>;
  detectLayoutProblems(input: VisualAnalysisInput): Promise<VisualFinding[]>;
}

/**
 * Structural analyzer: produces metadata + a deterministic description from the
 * screenshot + DOM without invoking any model. Suitable as the default for the
 * loop until a vision analyzer is configured.
 */
export class StructuralVisualAnalyzer implements VisualAnalyzer {
  readonly name = "structural";

  async analyzeScreenshot(input: VisualAnalysisInput): Promise<VisualAnalysisResult> {
    const metadata: Record<string, unknown> = {
      hasScreenshot: Boolean(input.screenshot || input.screenshotPath),
      screenshotBytes: input.screenshot ? Math.round(input.screenshot.data.length * 0.75) : undefined,
      screenshotWidth: input.screenshot?.width,
      screenshotHeight: input.screenshot?.height,
      hasDom: Boolean(input.dom),
      domLength: input.dom?.length,
      consoleEntryCount: input.console?.length ?? 0,
      networkEntryCount: input.network?.length ?? 0,
    };
    const headings = extractHeadings(input.dom ?? "");
    const description = [
      `Screenshot ${input.screenshot ? `${input.screenshot.width}x${input.screenshot.height}` : "not captured"}.`,
      `Page headings: ${headings.length ? headings.join(" → ") : "none detected"}.`,
      `Console entries: ${input.console?.length ?? 0}; network entries: ${input.network?.length ?? 0}.`,
    ].join(" ");
    return { findings: [], description, metadata };
  }

  async compareScreenshots(baseline: VisualAnalysisInput, current: VisualAnalysisInput): Promise<CompareResult> {
    return compareScreenshotHashes(baseline, current);
  }

  async detectLayoutProblems(input: VisualAnalysisInput): Promise<VisualFinding[]> {
    const findings: VisualFinding[] = [];
    const dom = input.dom ?? "";
    // Heuristic checks over the DOM snapshot.
    if (/overflow-x\s*:\s*hidden/.test(dom) && isSuspicious(dom)) {
      findings.push({
        severity: "medium",
        category: "layout",
        description: "The page sets horizontal overflow:hidden, which can mask content clipping on small screens.",
      });
    }
    return findings;
  }
}

export interface VisualAnalyzerRegistry {
  get(name?: string): VisualAnalyzer;
  getDefault(): VisualAnalyzer;
}

export function createVisualAnalyzerRegistry(analyzers?: VisualAnalyzer[]): VisualAnalyzerRegistry {
  const map = new Map<string, VisualAnalyzer>();
  const defaultAnalyzer = new StructuralVisualAnalyzer();
  map.set(defaultAnalyzer.name, defaultAnalyzer);
  for (const a of analyzers ?? []) {
    map.set(a.name, a);
  }
  return {
    get(name) {
      if (!name || !map.has(name)) return defaultAnalyzer;
      return map.get(name)!;
    },
    getDefault() {
      return defaultAnalyzer;
    },
  };
}

/**
 * Deterministic screenshot comparison using a perceptual-ish hash of the base64
 * PNG. This is a placeholder implementation that establishes the interface;
 * real pixel diffing (e.g. pixelmatch) can be added behind the same CompareResult.
 */
export async function compareScreenshotHashes(
  baseline: VisualAnalysisInput,
  current: VisualAnalysisInput,
): Promise<CompareResult> {
  const b = baseline.screenshot?.data ?? null;
  const c = current.screenshot?.data ?? null;
  if (!b || !c) {
    return { identical: false, diffRatio: 1, diffPixels: 0, totalPixels: 0, notes: "one or both screenshots missing" };
  }
  if (b.length === c.length && b === c) {
    return { identical: true, diffRatio: 0, diffPixels: 0, totalPixels: comparablePixelCount(current) };
  }
  // Differing encodings/lengths => treat as different.
  const hamming = hammingDistanceOfHashes(b, c);
  return {
    identical: false,
    diffRatio: Math.min(1, hamming / 4096),
    diffPixels: hamming,
    totalPixels: comparablePixelCount(current),
    notes: "structural hash comparison (placeholder for pixel diffing)",
  };
}

function comparablePixelCount(input: VisualAnalysisInput): number {
  const w = input.screenshot?.width ?? 0;
  const h = input.screenshot?.height ?? 0;
  return w && h ? w * h : 0;
}

function hammingDistanceOfHashes(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < len; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) dist++;
  }
  dist += Math.abs(a.length - b.length);
  return dist;
}

function extractHeadings(dom: string): string[] {
  const out: string[] = [];
  const re = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dom)) !== null && out.length < 6) {
    const text = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (text) out.push(`h${m[1]}:${text}`);
  }
  return out;
}

function isSuspicious(_dom: string): boolean {
  // Placeholder heuristic; reserved for future logic.
  return true;
}
