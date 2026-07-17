import { describe, expect, it, vi } from "vitest";
import { createDashboardRefreshCoordinator } from "./dashboardRefreshCoordinator";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("dashboard refresh coordinator", () => {
  it("coalesces ten signals during one request into one merged follow-up", async () => {
    const batches = [deferred(), deferred()];
    let batchIndex = 0;
    const seenKeys: string[][] = [];
    const execute = vi.fn((context: { keys: readonly string[] }) => {
      seenKeys.push([...context.keys]);
      return batches[batchIndex++].promise;
    });
    const coordinator = createDashboardRefreshCoordinator<string>({ execute });

    const drained = coordinator.request(["overview"]);
    for (let index = 0; index < 10; index += 1) {
      void coordinator.request([index % 2 === 0 ? "runs" : "issues"]);
    }

    expect(execute).toHaveBeenCalledTimes(1);
    batches[0].resolve();
    await flushPromises();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(new Set(seenKeys[1])).toEqual(new Set(["runs", "issues"]));
    batches[1].resolve();
    await drained;
  });

  it("rejects a superseded result for a resource before the follow-up starts", async () => {
    const batches = [deferred(), deferred()];
    const committed: number[] = [];
    const execute = vi.fn(async (context) => {
      const batchIndex = execute.mock.calls.length - 1;
      await batches[batchIndex].promise;
      if (context.isAuthoritative("overview")) committed.push(context.generation);
    });
    const coordinator = createDashboardRefreshCoordinator<string>({ execute });

    const drained = coordinator.request(["overview"]);
    void coordinator.request(["overview"]);
    batches[0].resolve();
    await flushPromises();
    expect(committed).toEqual([]);
    batches[1].resolve();
    await drained;
    expect(committed).toHaveLength(1);
  });

  it("continues with queued keys after a rejected request", async () => {
    const first = deferred();
    const second = deferred();
    const failure = vi.fn();
    const execute = vi
      .fn<(context: { keys: readonly string[] }) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = createDashboardRefreshCoordinator({
      execute,
      onFailure: failure,
    });

    const drained = coordinator.request(["overview"]);
    void coordinator.request(["runs"]);
    first.reject(new Error("offline"));
    await flushPromises();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0].keys).toEqual(["runs"]);
    second.resolve();
    await drained;
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("settles a queued caller after its batch while later polling work runs", async () => {
    const batches = [deferred(), deferred(), deferred()];
    let batchIndex = 0;
    const execute = vi.fn(() => batches[batchIndex++].promise);
    const coordinator = createDashboardRefreshCoordinator<string>({ execute });
    let mutationSettled = false;

    void coordinator.request(["worker"]);
    const mutation = coordinator.request(["overview", "runs"]).then(() => {
      mutationSettled = true;
    });

    batches[0].resolve();
    await flushPromises();
    expect(execute).toHaveBeenCalledTimes(2);

    void coordinator.request(["worker"]);
    batches[1].resolve();
    await mutation;

    expect(mutationSettled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
    batches[2].resolve();
    await flushPromises();
  });

  it("suppresses background failures without suppressing requested failures", async () => {
    const batches = [deferred(), deferred()];
    let batchIndex = 0;
    const failure = vi.fn();
    const execute = vi.fn(() => batches[batchIndex++].promise);
    const coordinator = createDashboardRefreshCoordinator<string>({
      execute,
      onFailure: failure,
    });

    const background = coordinator.request(["worker"], {
      reportFailure: false,
    });
    batches[0].reject(new Error("transient poll failure"));
    await background;
    expect(failure).not.toHaveBeenCalled();

    const requested = coordinator.request(["overview"]);
    batches[1].reject(new Error("requested refresh failure"));
    await requested;
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0][1]).toEqual(["overview"]);
  });

  it("does not commit or start queued work after disposal", async () => {
    const active = deferred();
    const committed = vi.fn();
    const execute = vi.fn(async (context) => {
      await active.promise;
      if (context.isAuthoritative("overview")) committed();
    });
    const coordinator = createDashboardRefreshCoordinator<string>({ execute });

    const drained = coordinator.request(["overview"]);
    void coordinator.request(["runs"]);
    coordinator.dispose();
    await drained;
    active.resolve();
    await flushPromises();

    expect(committed).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
