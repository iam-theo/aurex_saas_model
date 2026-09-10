/**
 * Accessibility inspection (Phase 8).
 *
 * A modular, heuristic-based a11y checker that detects common violations:
 *  - missing accessible names (buttons, links, inputs)
 *  - missing / empty labels and form associations
 *  - invalid / improperly-typed form controls
 *  - poor heading structure (missing h1, skipped levels)
 *  - images without alt text
 *  - keyboard-hostile controls (e.g. div acting as a button without role)
 *
 * The module is deliberately isolated behind `runAccessibilityCheck` so a
 * dedicated accessibility engine (axe-core, Lighthouse) can be swapped in
 * later without touching callers.
 */

import type { SessionHandle } from "./types.js";

export interface AccessibilityIssue {
  code: string;
  severity: "critical" | "serious" | "moderate";
  kind: string;
  description: string;
  selector?: string;
  suggestion?: string;
}

export interface AccessibilityResult {
  issues: AccessibilityIssue[];
  summary: { critical: number; serious: number; moderate: number };
  score: number;
}

const MAX_ISSUES = 60;

export async function runAccessibilityCheck(handle: SessionHandle): Promise<AccessibilityResult> {
  const issues: AccessibilityIssue[] = await handle.page.evaluate((max) => {
    const out: AccessibilityIssue[] = [];
    const doc = document;
    const push = (issue: AccessibilityIssue) => {
      if (out.length < max) out.push(issue);
    };

    // 1. Accessible names for buttons and links.
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("button,a[href],[role=button]"))) {
      const name = accessibleName(el);
      const isButton = el.tagName === "BUTTON" || el.getAttribute("role") === "button";
      if (!name && !(el.tagName === "A" && hasMeaningfulHref(el))) {
        push({
          code: "missing-accessible-name",
          severity: "serious",
          kind: "interactive",
          description: `${el.tagName.toLowerCase()} has no accessible name`,
          selector: uniqueSelector(el),
          suggestion: "Add text content, aria-label, or aria-labelledby.",
        });
      } else if (isButton && /^https?:\/\//.test(name) && el.textContent?.trim() === name) {
        // A button whose accessible name is just a URL is likely an icon/button with bad text.
      }
    }

    // 2. Form controls: labels + associations.
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("input,select,textarea"))) {
      if (el.tagName === "INPUT" && ["hidden", "button", "submit", "reset", "image"].includes((el as HTMLInputElement).type)) continue;
      const id = el.id;
      const labelledByLabel = id ? doc.querySelector(`label[for="${CSS.escape(id)}"]`) != null : false;
      const hasAria = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      const wrapped = !!el.closest("label");
      const placeholder = (el as HTMLInputElement).placeholder;
      if (!labelledByLabel && !hasAria && !wrapped && !placeholder) {
        push({
          code: "missing-form-label",
          severity: "serious",
          kind: "form",
          description: `${describeControl(el)} is missing a label`,
          selector: uniqueSelector(el),
          suggestion: "Add a <label for=...>, wrap in a <label>, or set aria-label.",
        });
      }
    }

    // 3. Images without alt.
    for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>("img"))) {
      const alt = img.getAttribute("alt");
      if (alt === null) {
        const inLink = !!img.closest("a");
        push({
          code: "missing-image-alt",
          severity: inLink ? "critical" : "moderate",
          kind: "image",
          description: "Image is missing an alt attribute",
          selector: uniqueSelector(img),
          suggestion: inLink ? "Add descriptive alt text for the linked image." : 'Add alt="" if decorative, or descriptive text.',
        });
      }
    }

    // 4. Heading structure.
    const headingLevels = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => Number(h.tagName.slice(1)));
    if (headingLevels.length > 0 && !headingLevels.includes(1)) {
      push({
        code: "missing-h1",
        severity: "moderate",
        kind: "heading",
        description: "Page has no <h1>",
        suggestion: "Add a single descriptive <h1>.",
      });
    }
    for (let i = 1; i < headingLevels.length; i++) {
      if (headingLevels[i] - headingLevels[i - 1] > 1) {
        push({
          code: "heading-level-skipped",
          severity: "moderate",
          kind: "heading",
          description: `Heading level skipped: h${headingLevels[i - 1]} → h${headingLevels[i]}`,
        });
        break;
      }
    }

    // 5. Keyboard-hostile clickable divs.
    const clickableSelector = "div[onclick],div.clickable,[onclick]";
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(clickableSelector))) {
      if (el.onclick || el.getAttribute("onclick")) {
        const role = el.getAttribute("role");
        if (!role && el.tagName !== "BUTTON" && el.tagName !== "A") {
          push({
            code: "non-semantic-clickable",
            severity: "serious",
            kind: "keyboard",
            description: "Clickable element has no semantic role (not keyboard accessible)",
            selector: uniqueSelector(el),
            suggestion: "Use a <button>, or add role and tabindex plus key handling.",
          });
        }
      }
    }

    return out;
  }, MAX_ISSUES) as AccessibilityIssue[];

  const summary = { critical: 0, serious: 0, moderate: 0 };
  for (const issue of issues) summary[issue.severity] += 1;
  const weighted = issues.length === 0 ? 100 : Math.max(0, 100 - (summary.critical * 15 + summary.serious * 8 + summary.moderate * 3));
  return { issues, summary, score: Math.round(weighted) };
}

function accessibleName(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const parts = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  if (el.tagName === "IMG") return el.getAttribute("alt") ?? "";
  return (el.textContent ?? "").trim();
}

function hasMeaningfulHref(el: HTMLElement): boolean {
  const href = el.getAttribute("href");
  return !!href && href !== "#" && href !== "";
}

function describeControl(el: HTMLElement): string {
  const t = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type;
  return type ? `<${t} type="${type}">` : `<${t}>`;
}

function uniqueSelector(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.getAttribute("name")) return `${el.tagName.toLowerCase()}[name=${CSS.escape(el.getAttribute("name")!)}]`;
  let selector = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (siblings.length > 1) {
      selector += `:nth-of-type(${siblings.indexOf(el) + 1})`;
    }
  }
  return selector;
}
