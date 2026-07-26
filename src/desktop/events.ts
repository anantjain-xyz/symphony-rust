import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEventRow } from "../bindings";

export type DbChanged = {
  type: "db_changed";
  table: string;
  op: string;
};

export type AgentEvent = {
  type: "agent_event";
  event: AgentEventRow;
};

export type RateLimitChanged = {
  type: "rate_limit_changed";
  source: string;
};

export type DesktopEventHandlers = {
  onDbChanged: (event: DbChanged) => void;
  onAgentEvent: (event: AgentEvent) => void;
  onRateLimitChanged: (event: RateLimitChanged) => void;
  onError: (error: unknown) => void;
};

function runCleanupOnce(unlisteners: readonly UnlistenFn[]) {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    for (const unlisten of unlisteners) {
      try {
        unlisten();
      } catch {
        // One broken bridge cleanup must not strand the remaining listeners.
      }
    }
  };
}

/**
 * Register the desktop event family as one owned subscription.
 *
 * Cleanup is safe before, during, or after async registration and is
 * idempotent under React Strict Mode remounts.
 */
export function subscribeDesktopEvents(handlers: DesktopEventHandlers): () => void {
  let disposed = false;
  const cleanups = new Set<() => void>();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  };

  const fail = (error: unknown) => {
    if (disposed) return;
    dispose();
    handlers.onError(error);
  };

  const register = (start: () => Promise<UnlistenFn>) => {
    if (disposed) return;
    let registration: Promise<UnlistenFn>;
    try {
      registration = start();
    } catch (error) {
      fail(error);
      return;
    }
    void registration.then((unlisten) => {
      const cleanup = runCleanupOnce([unlisten]);
      if (disposed) {
        cleanup();
      } else {
        cleanups.add(cleanup);
      }
    }, fail);
  };

  register(() =>
    listen<DbChanged>("db_changed", ({ payload }) => {
      if (!disposed) handlers.onDbChanged(payload);
    }),
  );
  register(() =>
    listen<AgentEvent>("agent_event", ({ payload }) => {
      if (!disposed) handlers.onAgentEvent(payload);
    }),
  );
  register(() =>
    listen<RateLimitChanged>("rate_limit_changed", ({ payload }) => {
      if (!disposed) handlers.onRateLimitChanged(payload);
    }),
  );

  return dispose;
}
