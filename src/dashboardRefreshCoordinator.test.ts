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
  it("unions a burst into one bounded follow-up without losing keys", async () => {
    const batches = [deferred(), deferred()];
    const seen: string[][] = [];
    let index = 0;
    const coordinator = createDashboardRefreshCoordinator<string>({
      execute: ({ keys }) => {
        seen.push([...keys]);
        return batches[index++].promise;
      },
    });

    const first = coordinator.request(["overview"]);
    for (let signal = 0; signal < 20; signal += 1) {
      void coordinator.request([signal % 2 === 0 ? "runs" : "issues"]);
    }
    expect(seen).toEqual([["overview"]]);
    batches[0].resolve();
    await flushPromises();
    expect(seen).toHaveLength(2);
    expect(new Set(seen[1])).toEqual(new Set(["runs", "issues"]));
    batches[1].resolve();
    await first;
  });

  it("rejects stale commits by resource and drains after failure", async () => {
    const batches = [deferred(), deferred()];
    const commits: number[] = [];
    const failure = vi.fn();
    let index = 0;
    const coordinator = createDashboardRefreshCoordinator<string>({
      execute: async (context) => {
        const current = index++;
        await batches[current].promise;
        if (context.isAuthoritative("selectedRun")) commits.push(current);
      },
      onFailure: failure,
    });
    const first = coordinator.request(["selectedRun"]);
    const second = coordinator.request(["selectedRun"]);
    batches[0].reject(new Error("stale failure"));
    await flushPromises();
    expect(failure).toHaveBeenCalledOnce();
    batches[1].resolve();
    await Promise.all([first, second]);
    expect(commits).toEqual([1]);
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
