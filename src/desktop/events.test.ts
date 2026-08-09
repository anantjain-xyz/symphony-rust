import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeDesktopEvents } from "./events";

const eventMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: eventMocks.emit,
  listen: eventMocks.listen,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushRegistration() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("desktop event subscription", () => {
  beforeEach(() => {
    eventMocks.emit.mockReset();
    eventMocks.emit.mockResolvedValue(undefined);
    eventMocks.listen.mockReset();
  });

  it("forwards the typed event family and cleans every listener exactly once", async () => {
    const unlisteners = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    unlisteners[0].mockImplementation(() => {
      throw new Error("already detached");
    });
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    eventMocks.listen.mockImplementation(async (name, callback) => {
      callbacks.set(name, callback);
      return unlisteners[callbacks.size - 1];
    });
    const handlers = {
      onDbChanged: vi.fn(),
      onAgentEvent: vi.fn(),
      onRateLimitChanged: vi.fn(),
      onWorkflowReady: vi.fn(),
      onCheckForUpdates: vi.fn(),
      onError: vi.fn(),
    };

    const unsubscribe = subscribeDesktopEvents(handlers);
    await flushRegistration();
    callbacks.get("db_changed")?.({
      payload: { type: "db_changed", table: "runs", op: "update" },
    });
    callbacks.get("agent_event")?.({
      payload: {
        type: "agent_event",
        event: {
          id: 1,
          run_id: "run-1",
          kind: "status",
          payload: "{}",
          created_at: "2026-07-26T00:00:00.000Z",
        },
      },
    });
    callbacks.get("rate_limit_changed")?.({
      payload: { type: "rate_limit_changed", source: "codex" },
    });
    callbacks.get("workflow_ready")?.({
      payload: { type: "workflow_ready" },
    });
    callbacks.get("check-for-updates-requested")?.({ payload: undefined });

    expect(handlers.onDbChanged).toHaveBeenCalledOnce();
    expect(handlers.onAgentEvent).toHaveBeenCalledOnce();
    expect(handlers.onRateLimitChanged).toHaveBeenCalledOnce();
    expect(handlers.onWorkflowReady).toHaveBeenCalledOnce();
    expect(handlers.onCheckForUpdates).toHaveBeenCalledOnce();
    expect(eventMocks.emit).toHaveBeenCalledWith("up:r");
    expect(eventMocks.emit).toHaveBeenCalledWith("up:a");
    expect(() => unsubscribe()).not.toThrow();
    unsubscribe();
    expect(unlisteners.map((unlisten) => unlisten.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("cleans late and partial registrations after an early Strict Mode teardown", async () => {
    const registrations = [
      deferred<() => void>(),
      deferred<() => void>(),
      deferred<() => void>(),
      deferred<() => void>(),
      deferred<() => void>(),
    ];
    const unlisteners = [vi.fn(), vi.fn()];
    eventMocks.listen
      .mockReturnValueOnce(registrations[0].promise)
      .mockReturnValueOnce(registrations[1].promise)
      .mockReturnValueOnce(registrations[2].promise)
      .mockReturnValueOnce(registrations[3].promise)
      .mockReturnValueOnce(registrations[4].promise);
    const handlers = {
      onDbChanged: vi.fn(),
      onAgentEvent: vi.fn(),
      onRateLimitChanged: vi.fn(),
      onWorkflowReady: vi.fn(),
      onCheckForUpdates: vi.fn(),
      onError: vi.fn(),
    };

    const unsubscribe = subscribeDesktopEvents(handlers);
    unsubscribe();
    unsubscribe();
    registrations[0].resolve(unlisteners[0]);
    registrations[2].resolve(unlisteners[1]);
    await flushRegistration();

    expect(unlisteners.map((unlisten) => unlisten.mock.calls.length)).toEqual([1, 1]);
    expect(handlers.onError).not.toHaveBeenCalled();

    registrations[1].reject(new Error("event bridge unavailable"));
    registrations[3].resolve(vi.fn());
    registrations[4].resolve(vi.fn());
    await flushRegistration();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("reports one active registration failure and cleans late listeners", async () => {
    const registrations = [
      deferred<() => void>(),
      deferred<() => void>(),
      deferred<() => void>(),
      deferred<() => void>(),
      deferred<() => void>(),
    ];
    const unlisteners = [vi.fn(), vi.fn()];
    eventMocks.listen
      .mockReturnValueOnce(registrations[0].promise)
      .mockReturnValueOnce(registrations[1].promise)
      .mockReturnValueOnce(registrations[2].promise)
      .mockReturnValueOnce(registrations[3].promise)
      .mockReturnValueOnce(registrations[4].promise);
    const handlers = {
      onDbChanged: vi.fn(),
      onAgentEvent: vi.fn(),
      onRateLimitChanged: vi.fn(),
      onWorkflowReady: vi.fn(),
      onCheckForUpdates: vi.fn(),
      onError: vi.fn(),
    };

    subscribeDesktopEvents(handlers);
    registrations[0].resolve(unlisteners[0]);
    await flushRegistration();
    registrations[1].reject(new Error("event bridge unavailable"));
    await flushRegistration();

    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(unlisteners[0]).toHaveBeenCalledOnce();

    registrations[2].resolve(unlisteners[1]);
    registrations[3].resolve(vi.fn());
    registrations[4].resolve(vi.fn());
    await flushRegistration();
    expect(unlisteners[1]).toHaveBeenCalledOnce();
  });
});
