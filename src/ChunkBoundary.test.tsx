// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkErrorBoundary, ViewLoading } from "./ChunkBoundary";

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
type ViewLoader = (() => Promise<ViewModule>) & {
  loaded?: () => ViewModule | null;
};

function createHarness(loader: ViewLoader) {
  const attempts = [lazy(loader), lazy(loader)];
  return function Harness() {
    const [active, setActive] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const View =
      loader.loaded?.()?.default ?? attempts[Math.min(attempt, attempts.length - 1)];
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
        </nav>
        {active ? (
          <ChunkErrorBoundary
            key={attempt}
            view="Runs"
            onRetry={() => setAttempt((current) => current + 1)}
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
    loader.loaded = () => loaded;
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

    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(screen.queryByText("Loading Runs…")).toBeNull();
    expect(importView).toHaveBeenCalledTimes(1);
  });

  it("contains a rejected chunk and retries without removing the shell", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = deferred<ViewModule>();
    const second = deferred<ViewModule>();
    let cached: Promise<ViewModule> | null = null;
    const importView = vi
      .fn<() => Promise<ViewModule>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
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

    await act(async () => {
      first.reject(new Error("chunk unavailable"));
      await first.promise.catch(() => undefined);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Unable to load Runs");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      second.resolve({ default: () => <h2>Runs</h2> });
      await second.promise;
    });
    expect(await screen.findByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(importView).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
