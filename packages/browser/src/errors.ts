/**
 * Shared error types for the browser subsystem.
 */

export class BrowserError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "BrowserError";
  }
}
