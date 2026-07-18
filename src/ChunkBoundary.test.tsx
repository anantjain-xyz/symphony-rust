// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, useState } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChunkErrorBoundary,
  ViewLoading,
  createLazyAttempts,
} from "./ChunkBoundary";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type ViewModule = { default: () => ReactNode };
type ViewLoader = () => Promise<ViewModule>;

function createHarness(loader: ViewLoader) {
  const attempts = createLazyAttempts(loader);
  return function Harness() {
    const [active, setActive] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [, setShellRefresh] = useState(0);
    const View = attempts.get(attempt);
    const preload = () => void loader().catch(() => undefined);
    return (
      <main>
        <nav aria-label="Primary">
          <button
            onPointerEnter={preload}
            onFocus={preload}
            onClick={() => setActive(true)}
          >
            Runs
          </button>
          <button onClick={() => setShellRefresh((value) => value + 1)}>
            Refresh shell
          </button>
        </nav>
        {active ? (
          <ChunkErrorBoundary
            key={attempt}
            view="Runs"
            onRetry={() => setAttempt(attempts.add())}
          >
            <Suspense fallback={<ViewLoading view="Runs" />}>
              <View />
            </Suspense>
          </ChunkErrorBoundary>
        ) : (
          <h2>Overview</h2>
        )}
      </main>
    );
  };
}

describe("lazy view boundaries", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps navigation usable and shows a view-shaped fallback on cold navigation", async () => {
    const pending = deferred<ViewModule>();
    const Harness = createHarness(() => pending.promise);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Runs" }));

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    expect(screen.getByText("Loading Runs…").closest("[aria-busy='true']")).toBeTruthy();

    await act(async () => {
      pending.resolve({ default: () => <h2>Runs</h2> });
      await pending.promise;
    });
    expect(await screen.findByRole("heading", { name: "Runs" })).toBeTruthy();
  });

  it("preloads once across pointer and keyboard intent before navigation", async () => {
    const pending = deferred<ViewModule>();
    const importView = vi.fn(() => pending.promise);
    let cached: Promise<ViewModule> | null = null;
    let loaded: ViewModule | null = null;
    const loader: ViewLoader = () =>
      (cached ??= importView().then((module) => (loaded = module)));
    const Harness = createHarness(loader);
    render(<Harness />);
    const button = screen.getByRole("button", { name: "Runs" });

    fireEvent.pointerEnter(button);
    fireEvent.focus(button);
    expect(importView).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ default: () => <h2>Runs</h2> });
      await pending.promise;
    });
    fireEvent.click(button);

    expect(await screen.findByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(screen.queryByText("Loading Runs…")).toBeNull();
    expect(importView).toHaveBeenCalledTimes(1);
    expect(loaded).not.toBeNull();
  });

  it("contains repeated chunk failures and retries until a later import succeeds", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const imports = [
      deferred<ViewModule>(),
      deferred<ViewModule>(),
      deferred<ViewModule>(),
      deferred<ViewModule>(),
    ];
    let cached: Promise<ViewModule> | null = null;
    const importView = vi.fn<() => Promise<ViewModule>>();
    imports.forEach(({ promise }) => importView.mockImplementationOnce(() => promise));
    const loader = () => {
      if (!cached) {
        cached = importView().catch((error) => {
          cached = null;
          throw error;
        });
      }
      return cached;
    };
    const Harness = createHarness(loader);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));

    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        imports[index].reject(new Error(`chunk unavailable ${index + 1}`));
        await imports[index].promise.catch(() => undefined);
      });
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Unable to load Runs",
      );
      expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    }
    await act(async () => {
      imports[3].resolve({ default: () => <h2>Runs</h2> });
      await imports[3].promise;
    });
    expect(await screen.findByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(importView).toHaveBeenCalledTimes(4);
    consoleError.mockRestore();
  });

  it("restores the latest nested chunk attempt after its owner remounts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = deferred<ViewModule>();
    const second = deferred<ViewModule>();
    const loader = vi
      .fn<() => Promise<ViewModule>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const attempts = createLazyAttempts(loader);

    function NestedBoundary() {
      const [attempt, setAttempt] = useState(() => attempts.latest());
      const View = attempts.get(attempt);
      return (
        <ChunkErrorBoundary
          key={attempt}
          view="Dependency graph"
          onRetry={() => setAttempt(attempts.add())}
        >
          <Suspense fallback={<ViewLoading view="Dependency graph" />}>
            <View />
          </Suspense>
        </ChunkErrorBoundary>
      );
    }

    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <main>
          <button onClick={() => setVisible((value) => !value)}>
            {visible ? "Hide graph" : "Show graph"}
          </button>
          {visible ? <NestedBoundary /> : null}
        </main>
      );
    }

    render(<Harness />);
    await act(async () => {
      first.reject(new Error("dependency chunk unavailable"));
      await first.promise.catch(() => undefined);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await act(async () => {
      second.resolve({ default: () => <h2>Dependency graph</h2> });
      await second.promise;
    });
    expect(await screen.findByRole("heading", { name: "Dependency graph" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide graph" }));
    fireEvent.click(screen.getByRole("button", { name: "Show graph" }));

    expect(await screen.findByRole("heading", { name: "Dependency graph" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("keeps the loaded lazy component mounted across shell rerenders", async () => {
    const pending = deferred<ViewModule>();
    function StatefulRuns() {
      const [count, setCount] = useState(0);
      return (
        <section>
          <h2>Runs</h2>
          <button onClick={() => setCount((value) => value + 1)}>Count {count}</button>
        </section>
      );
    }
    const Harness = createHarness(() => pending.promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    await act(async () => {
      pending.resolve({ default: StatefulRuns });
      await pending.promise;
    });

    fireEvent.click(await screen.findByRole("button", { name: "Count 0" }));
    expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh shell" }));
    expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
  });
});
