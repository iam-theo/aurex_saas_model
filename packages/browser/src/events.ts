/**
 * Browser event bus.
 *
 * Provides structured browser lifecycle events (Phase 14) that can be
 * subscribed to by the surrounding Aurex infrastructure (worker, SSE relay,
 * logging) without coupling the browser runtime to a specific transport.
 *
 * Keep this dependency-free so it works both inside the workspace container
 * (node >= 20 has global EventTarget) and on the host.
 */

export type BrowserEventType =
  | "browser.session.created"
  | "browser.session.closed"
  | "browser.navigation.started"
  | "browser.navigation.completed"
  | "browser.navigation.failed"
  | "browser.console.error"
  | "browser.network.error"
  | "browser.screenshot.created"
  | "browser.qa.started"
  | "browser.qa.failed"
  | "browser.qa.passed"
  | "browser.qa.iteration";

export interface BrowserEvent<D = unknown> {
  type: BrowserEventType;
  timestamp: string;
  sessionId?: string;
  data: D;
}

type Listener<D = unknown> = (evt: BrowserEvent<D>) => void;

/**
 * Tiny typed event bus backed by the platform EventTarget. Subscribers are
 * called synchronously in subscription order.
 */
export interface BrowserEventBus {
  emit: <D>(type: BrowserEventType, data: D, sessionId?: string) => void;
  on: <D>(type: BrowserEventType, listener: Listener<D>) => () => void;
}

export function createEventBus(): BrowserEventBus {
  const listeners = new Map<BrowserEventType, Set<Listener<any>>>();
  return {
    emit(type, data, sessionId) {
      const set = listeners.get(type);
      if (!set) return;
      const evt: BrowserEvent = { type, timestamp: new Date().toISOString(), sessionId, data };
      for (const fn of [...set]) {
        try {
          fn(evt);
        } catch (e) {
          // A subscriber must never break the browser runtime.
          console.error("[aurex-browser] event listener error:", e);
        }
      }
    },
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
}
