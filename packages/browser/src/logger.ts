/**
 * Structured logger for the browser subsystem.
 *
 * A provider-agnostic logger that emits JSON lines by default. The transport
 * can be swapped (e.g. to the Aurex SSE event relay) without changing call
 * sites. All log methods accept a message plus structured fields.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface AurexLogger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  child: (fields: LogFields) => AurexLogger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: LogFields) => void;
  baseFields?: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const NULL_LOGGER: AurexLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NULL_LOGGER,
};

export function createLogger(opts: LoggerOptions = {}): AurexLogger {
  const level = opts.level ?? "info";
  const threshold = LEVEL_ORDER[level];
  const sink = opts.sink ?? ((line) => console.log(JSON.stringify(line)));
  const base = opts.baseFields ?? {};

  function write(lvl: LogLevel, msg: string, fields: LogFields = {}) {
    if (LEVEL_ORDER[lvl] < threshold) return;
    if (lvl === "error") {
      const err = fields["err"] ?? fields["error"];
      if (err instanceof Error && fields["err"] === undefined) {
        fields = { ...fields, err: { message: err.message, stack: err.stack } };
      }
    }
    sink({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields });
  }

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ level, sink, baseFields: { ...base, ...fields } }),
  };
}
