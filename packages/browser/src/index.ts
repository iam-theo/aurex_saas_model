/**
 * @aurex/browser — Aurex Headless Browser & Autonomous Web QA capability.
 *
 * Public surface of the browser subsystem. Everything downstream (tools,
 * worker integration, QA orchestration) imports from here.
 */

// Configuration
export {
  resolveBrowserConfig,
  DEFAULT_BROWSER_CONFIG,
  type BrowserConfig,
} from "./config.js";

// Events + logging
export { createEventBus, type BrowserEventBus, type BrowserEvent, type BrowserEventType } from "./events.js";
export { createLogger, NULL_LOGGER, type AurexLogger, type LogFields, type LogLevel, type LoggerOptions } from "./logger.js";

// Security
export {
  isUrlAllowed,
  isPrivateHost,
  isLoopback,
  isSensitiveHeader,
  headerValueLooksSensitive,
  isRequestUrlBlocked,
  sanitizeHeaders,
  sanitizeSecrets,
  redactHeaderValue,
  type HostAllowance,
} from "./security.js";

// Core runtime
export { BrowserRuntime } from "./runtime.js";
export { BrowserError } from "./errors.js";
export type {
  BrowserLaunchOptions,
  SessionDescriptor,
  ScreenshotOptions,
  ScreenshotResult,
} from "./runtime.js";

// Types
export {
  VIEWPORT_PRESETS,
  PRESET_VIEWPORTS,
  resolveViewport,
  type Viewport,
  type ViewportPreset,
  type ConsoleEntry,
  type NetworkEntry,
  type SessionHandle,
} from "./types.js";

// Inspection
export { inspectPage } from "./inspection.js";
export type {
  PageInspectionResult,
  InteractiveElement,
  BrokenImage,
  FormInfo,
  PageHeading,
  PageLink,
  PageImage,
} from "./inspection.js";

// Accessibility
export { runAccessibilityCheck } from "./accessibility.js";
export type { AccessibilityResult, AccessibilityIssue } from "./accessibility.js";

// Responsive
export { detectResponsiveIssues } from "./responsive.js";
export type { ResponsiveReport, ResponsiveIssue, ResponsiveViewportResult } from "./responsive.js";

// Application detection / startup
export {
  ApplicationRuntime,
  detectApplication,
  type Application,
  type ApplicationConfig,
  type ApplicationDetection,
  type ApplicationRuntimeOptions,
  type CommandRunner,
} from "./application.js";

// Flow execution
export { executeFlow, validateFlow, UnknownSecretError } from "./flow.js";
export type { FlowAction, FlowStep, FlowDefinition, FlowOptions, FlowResult, SecretResolver } from "./flow.js";

// Visual analysis
export {
  StructuralVisualAnalyzer,
  createVisualAnalyzerRegistry,
  compareScreenshotHashes,
  type VisualAnalyzer,
  type VisualAnalyzerRegistry,
  type VisualAnalysisInput,
  type VisualAnalysisResult,
  type VisualFinding,
  type CompareResult,
} from "./visual.js";

// QA orchestration
export { runBrowserQA, DEFAULT_QA_CONFIG } from "./qa.js";
export type {
  BrowserQAConfig,
  BrowserQAOptions,
  AgentDriver,
  Findings,
  Finding,
  QAIteration,
  QAResult,
  QASnapshot,
} from "./qa.js";

// Tool definitions
export { buildBrowserTools, pickParams, ToolInputError } from "./tools.js";
export type {
  BrowserToolDef,
  ToolContext,
  ToolParam,
  ToolIO,
} from "./tools.js";
