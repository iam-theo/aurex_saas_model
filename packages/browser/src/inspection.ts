/**
 * Comprehensive page inspection (Phase 5).
 *
 * Collects structured information about the current page: DOM (visible text,
 * headings, buttons, links, inputs, forms, images, interactive elements) plus
 * a snapshot of console errors/warnings, network errors and failed/broken
 * requests. Secrets are never included in the returned shape.
 */

import type { SessionHandle, ConsoleEntry, NetworkEntry } from "./types.js";
import { sanitizeSecrets } from "./security.js";

export interface InteractiveElement {
  tag: string;
  type?: string;
  text?: string;
  placeholder?: string;
  name?: string;
  role?: string;
  label?: string;
  disabled?: boolean;
  visible: boolean;
  selector?: string;
}

export interface BrokenImage {
  src: string;
  alt?: string;
  reason: string;
}

export interface FormInfo {
  action?: string;
  method?: string;
  inputs: number;
  id?: string;
}

export interface PageInspectionResult {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  headings: PageHeading[];
  visibleText: string;
  links: PageLink[];
  interactiveElements: InteractiveElement[];
  forms: FormInfo[];
  images: PageImage[];
  brokenImages: BrokenImage[];
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  networkErrors: NetworkEntry[];
  failedRequests: NetworkEntry[];
}

export interface PageHeading {
  level: number;
  text: string;
}

export interface PageLink {
  text: string;
  href: string;
  visible: boolean;
}

export interface PageImage {
  src: string;
  alt: string | null;
  visible: boolean;
}

export async function inspectPage(handle: SessionHandle): Promise<PageInspectionResult> {
  const { page, config } = handle;

  const base = await page.evaluate(() => {
    const doc = document;
    const viewport = { width: window.innerWidth, height: window.innerHeight };

    const headings: PageHeading[] = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .map((h) => ({ level: Number(h.tagName.slice(1)), text: (h.textContent ?? "").trim() }))
      .filter((h) => h.text);

    const links: PageLink[] = Array.from(doc.querySelectorAll("a[href]")).map((a) => ({
      text: (a.textContent ?? "").trim().slice(0, 200),
      href: (a as HTMLAnchorElement).href || ((a.getAttribute("href") as string) ?? ""),
      visible: isVisible(a as HTMLElement),
    }));

    const interactive: InteractiveElement[] = Array.from(
      doc.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link],[role=checkbox],summary"),
    )
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type;
        const label = labelFor(el as HTMLElement);
        return {
          tag,
          type,
          text: tag === "input" || tag === "select" || tag === "textarea" ? (label || el.getAttribute("aria-label") || "")?.slice(0, 120) : (el.textContent ?? "").trim().slice(0, 120),
          placeholder: (el as HTMLInputElement).placeholder,
          name: (el as HTMLInputElement).name,
          role: el.getAttribute("role") ?? undefined,
          label,
          disabled: (el as HTMLInputElement).disabled || (el as HTMLButtonElement).disabled,
          visible: isVisible(el as HTMLElement),
        };
      })
      .slice(0, 200);

    const forms: FormInfo[] = Array.from(doc.querySelectorAll("form")).map((f) => ({
      action: f.getAttribute("action") ?? undefined,
      method: (f.getAttribute("method") ?? "get").toLowerCase(),
      inputs: f.querySelectorAll("input,select,textarea,button").length,
      id: f.id || undefined,
    }));

    const images: PageImage[] = Array.from(doc.querySelectorAll("img")).map((img) => ({
      src: (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src || img.getAttribute("src") || "",
      alt: img.getAttribute("alt"),
      visible: isVisible(img),
    }));

    const visibleText = (doc.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 20_000);

    return { headings, links, interactive, forms, images, visibleText, viewport };
  });

  const title = await page.title();

  const brokenImages: BrokenImage[] = await page.evaluate(() => {
    const out: BrokenImage[] = [];
    for (const img of Array.from(document.querySelectorAll("img"))) {
      if (!(img as HTMLImageElement).complete || ((img as HTMLImageElement).naturalWidth === 0 && img.getAttribute("src"))) {
        out.push({
          src: (img as HTMLImageElement).src || img.getAttribute("src") || "",
          alt: img.getAttribute("alt") ?? undefined,
          reason: img.getAttribute("src") ? "failed to load or zero-sized" : "missing src",
        });
      }
    }
    return out.slice(0, 50);
  });

  return {
    url: page.url(),
    title,
    viewport: base.viewport,
    headings: base.headings,
    visibleText: config.sanitizeOutput ? sanitizeSecrets(base.visibleText) : base.visibleText,
    links: base.links,
    interactiveElements: base.interactive,
    forms: base.forms,
    images: base.images,
    brokenImages,
    consoleErrors: handle.consoleEntries.filter((e) => e.type === "error"),
    consoleWarnings: handle.consoleEntries.filter((e) => e.type === "warning"),
    networkErrors: handle.networkEntries.filter((e) => e.status !== null && e.status >= 400),
    failedRequests: handle.networkEntries.filter((e) => e.failed),
  };
}

function isVisible(el: HTMLElement): boolean {
  if (!el.offsetParent && el.tagName !== "BODY") {
    // offsetParent is null for position:fixed, which is still visible.
    const style = getComputedStyle(el);
    if (style.position !== "fixed") return false;
  }
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function labelFor(el: HTMLElement): string | undefined {
  const id = el.id;
  if (id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim();
    if (lbl) return lbl;
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const wrap = el.closest("label")?.textContent?.trim();
  if (wrap) return wrap;
  return undefined;
}

export type { SessionHandle };
