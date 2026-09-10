/**
 * Shared types for the browser subsystem.
 */

import type { BrowserConfig } from "./config.js";
import type { BrowserEventBus } from "./events.js";
import type { AurexLogger } from "./logger.js";
import type { Page } from "playwright-core";

export type ViewportPreset = "desktop" | "tablet" | "mobile";

export interface Viewport {
  width: number;
  height: number;
}

export const VIEWPORT_PRESETS: Record<ViewportPreset, Viewport> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

export const PRESET_VIEWPORTS: Viewport[] = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 375, height: 812 },
];

export function resolveViewport(width?: number, height?: number, preset?: ViewportPreset): Viewport {
  if (preset) return { ...VIEWPORT_PRESETS[preset] };
  return {
    width: width ?? 1440,
    height: height ?? 900,
  };
}

/**
 * The minimal surface the inspection/accessibility/responsive modules need
 * from a live browser session. The runtime implements this; defining it here
 * lets the sub-modules depend on this interface instead of the runtime class,
 * avoiding circular imports.
 */
export interface SessionHandle {
  sessionId: string;
  page: Page;
  viewport: Viewport;
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  config: BrowserConfig;
  logger: AurexLogger;
  events: BrowserEventBus;
}

export interface PageInspectionMatch {
  role?: string;
  name?: string;
  type?: string;
  selector?: string;
  text?: string;
  href?: string;
  alt?: string;
}

export interface ConsoleEntry {
  type: "log" | "warning" | "error" | "debug" | "info";
  text: string;
  location?: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status: number | null;
  resourceType: string;
  failed: boolean;
  error?: string;
  headers: Record<string, string>;
}
