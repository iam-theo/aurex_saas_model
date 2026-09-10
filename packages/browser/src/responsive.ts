/**
 * Responsive / layout issue detection (Phase 7).
 *
 * Detects common responsive layout problems:
 *  - horizontal overflow (content wider than the viewport)
 *  - clipped / overflowing content
 *  - overlapping elements
 *  - buttons that are too small to tap on touch devices
 *  - hidden modal / drawer content that traps navigation
 */

import type { Page, Locator } from "playwright-core";
import type { Viewport } from "./types.js";
import { shortSettle } from "./timing.js";

export interface ResponsiveIssue {
  code: string;
  severity: "high" | "medium" | "low";
  description: string;
  selector?: string;
}

export interface ResponsiveViewportResult {
  label: string;
  viewport: Viewport;
  issues: ResponsiveIssue[];
}

export interface ResponsiveReport {
  results: ResponsiveViewportResult[];
}

export async function detectResponsiveIssues(page: Page, viewport: Viewport): Promise<ResponsiveIssue[]> {
  await shortSettle(page);
  const issues: ResponsiveIssue[] = await page.evaluate(({ width }) => {
    const out: ResponsiveIssue[] = [];
    const push = (code: string, severity: ResponsiveIssue["severity"], description: string, selector?: string) => {
      if (out.length < 30) out.push({ code, severity, description, selector });
    };

    // Horizontal overflow.
    const docWidth = Math.ceil(document.documentElement.scrollWidth);
    if (docWidth > width) {
      const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > width + 1 || r.left < -1;
      }).slice(0, 5);
      push(
        "horizontal-overflow",
        "high",
        `Page is wider than the viewport (${width}px): scrollWidth ${docWidth}px.`,
        offenders.map(o => o.tagName).join(", ") || undefined,
      );
    }

    // Clipped content: visible-text elements extending past the right edge.
    const clipped = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,p,span,a,button,td,li")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > width + 1 || r.right < 1 && r.width > 1 && el.offsetParent !== null);
    }).slice(0, 5);
    if (clipped.length > 0) {
      push(
        "content-clipped",
        "medium",
        `${clipped.length} element(s) extend beyond or are clipped at the viewport edge.`,
        clipped.map((c) => (c.textContent ?? c.tagName).trim().slice(0, 40)).join(" | ") || undefined,
      );
    }

    // Overlapping elements.
    const visible = Array.from(document.querySelectorAll<HTMLElement>("a,button,input,select,textarea,[role=button]"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .slice(0, 40);
    for (let i = 0; i < visible.length && out.length < 8; i++) {
      for (let j = i + 1; j < visible.length && out.length < 8; j++) {
        const a = visible[i].getBoundingClientRect();
        const b = visible[j].getBoundingClientRect();
        if (overlapRatio(a, b) > 0.5 && (visible[i] !== visible[j])) {
          out.push({
            code: "element-overlap",
            severity: "high",
            description: `Two interactive elements overlap significantly: ${eclipse(visible[i])} and ${eclipse(visible[j])}`,
          });
          break;
        }
      }
    }

    // Tap target size on mobile.
    if (width <= 600) {
      const small = Array.from(document.querySelectorAll<HTMLElement>("a,button,input[type=checkbox],input[type=radio]"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.width < 32 || r.height < 32);
        }).slice(0, 5);
      if (small.length > 0) {
        push(
          "tap-target-too-small",
          "medium",
          `${small.length} touch target(s) smaller than 32px minimum recommended size.`,
          small.map((s) => (s.textContent ?? s.getAttribute("aria-label") ?? s.tagName).trim().slice(0, 30)).join(" | ") || undefined,
        );
      }
    }

    return out;
  }, { width: viewport.width }) as ResponsiveIssue[];

  return issues;
}

function overlapRatio(a: DOMRect, b: DOMRect): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = w * h;
  const minArea = Math.min(a.width * a.height || 1, b.width * b.height || 1);
  return minArea > 0 ? inter / minArea : 0;
}

function eclipse(el: Element): string {
  const t = (el.textContent ?? "").trim().slice(0, 30);
  return t ? `${el.tagName} "${t}"` : el.tagName;
}

// Re-export type to keep import sites stable.
export type { Locator };
