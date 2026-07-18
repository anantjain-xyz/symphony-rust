// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPollController, type PollResourceState } from "./pollController";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("poll controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is single-flight and schedules only after the active promise settles", async () => {
    const first = deferred<{ value: number }>();
    const poll = vi.fn(() => first.promise);
    const controller = createPollController({
      poll,
      fingerprint: ({ value }) => String(value),
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: vi.fn(),
      onError: vi.fn(),
      onStatus: vi.fn(),
    });

    controller.start();
    await advance(2_000);
    await advance(60_000);
    expect(poll).toHaveBeenCalledOnce();

    first.resolve({ value: 1 });
    await advance(1_999);
    expect(poll).toHaveBeenCalledOnce();
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it.each([
    ["worker", 2_000, [4_000, 8_000, 10_000], 34],
    ["retro", 1_500, [3_000, 6_000], 53],
    ["install or transfer", 2_000, [4_000, 8_000, 10_000], 34],
  ] as const)(
    "uses the exact %s unchanged schedule over five minutes",
    async (_name, baselineMs, unchangedBackoffMs, expectedCount) => {
      const poll = vi.fn(async () => ({ rendered: "unchanged" }));
      const controller = createPollController({
        poll,
        fingerprint: ({ rendered }) => rendered,
        baselineMs,
        unchangedBackoffMs,
        pauseWhenHidden: true,
        onResult: vi.fn(),
        onError: vi.fn(),
        onStatus: vi.fn(),
      });

      controller.start();
      await advance(5 * 60_000);
      expect(poll).toHaveBeenCalledTimes(expectedCount);
      controller.dispose();
    },
  );

  it("resets to baseline immediately when rendered state changes or reset is pushed", async () => {
    let rendered = "one";
    const poll = vi.fn(async () => rendered);
    const controller = createPollController({
      poll,
      fingerprint: (value) => value,
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: vi.fn(),
      onError: vi.fn(),
      onStatus: vi.fn(),
    });
    controller.start();
    await advance(2_000 + 2_000 + 2_000 + 2_000);
    expect(poll).toHaveBeenCalledTimes(4);

    rendered = "two";
    await advance(4_000);
    expect(poll).toHaveBeenCalledTimes(5);
    await advance(2_000);
    expect(poll).toHaveBeenCalledTimes(6);

    await advance(2_000 + 2_000);
    controller.reset();
    await advance(1_999);
    expect(poll).toHaveBeenCalledTimes(8);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(9);
    controller.dispose();
  });

  it("pauses while hidden and resumes with exactly one immediate request", async () => {
    const poll = vi.fn(async () => "same");
    const controller = createPollController({
      poll,
      fingerprint: (value) => value,
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: vi.fn(),
      onError: vi.fn(),
      onStatus: vi.fn(),
    });
    controller.start();
    setHidden(true);
    await advance(60_000);
    expect(poll).not.toHaveBeenCalled();

    setHidden(false);
    await advance(0);
    expect(poll).toHaveBeenCalledOnce();
    await advance(1_999);
    expect(poll).toHaveBeenCalledOnce();
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("does not issue a second immediate poll when an in-flight request settles hidden", async () => {
    const first = deferred<string>();
    const poll = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue("same");
    const controller = createPollController({
      poll,
      fingerprint: (value) => value,
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: vi.fn(),
      onStatus: vi.fn(),
    });
    controller.start();
    await advance(2_000);
    setHidden(true);
    first.resolve("same");
    await advance(0);

    setHidden(false);
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
    await advance(1_999);
    expect(poll).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(poll).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it("keeps stale resource state through a schedule reset until recovery succeeds", async () => {
    const statuses: PollResourceState[] = [];
    const poll = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("recovered");
    const controller = createPollController({
      poll,
      fingerprint: (value) => value,
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: vi.fn(),
      onStatus: (status) => statuses.push(status),
    });
    controller.start();
    await advance(2_000);
    expect(statuses[statuses.length - 1]).toMatchObject({ stale: true });

    controller.reset();
    expect(statuses[statuses.length - 1]).toMatchObject({ stale: true });
    await advance(2_000);
    expect(statuses[statuses.length - 1]).toMatchObject({
      consecutiveFailures: 0,
      stale: false,
    });
    controller.dispose();
  });

  it("continues stopping polls while hidden and caps repeated failures at ten seconds", async () => {
    const failure = new Error("offline");
    const poll = vi.fn(async () => Promise.reject(failure));
    const statuses: PollResourceState[] = [];
    const controller = createPollController({
      poll,
      fingerprint: String,
      baselineMs: 500,
      unchangedBackoffMs: [],
      pauseWhenHidden: false,
      failureMaxMs: 10_000,
      onResult: vi.fn(),
      onError: vi.fn(),
      onStatus: (status) => statuses.push(status),
    });
    setHidden(true);
    controller.start();
    await advance(500 + 2_000 + 4_000 + 8_000 + 10_000 + 10_000);
    expect(poll).toHaveBeenCalledTimes(6);
    expect(statuses[statuses.length - 1]).toMatchObject({
      consecutiveFailures: 6,
      stale: true,
    });
    controller.dispose();
  });

  it("retains the last good result while failures reach the thirty-second cap", async () => {
    const result = vi.fn();
    const error = vi.fn();
    const poll = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("good")
      .mockRejectedValue(new Error("offline"));
    const controller = createPollController({
      poll,
      fingerprint: (value) => value,
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: result,
      onError: error,
      onStatus: vi.fn(),
    });
    controller.start();
    await advance(2_000 + 2_000 + 2_000 + 4_000 + 8_000 + 16_000 + 30_000);
    expect(result).toHaveBeenCalledOnce();
    expect(result).toHaveBeenCalledWith("good");
    expect(error).toHaveBeenCalledTimes(6);
    expect(poll).toHaveBeenCalledTimes(7);
    controller.dispose();
  });

  it("stops on completion and ignores late results after disposal", async () => {
    const completedPoll = vi.fn(async () => "completed");
    const completedResult = vi.fn(() => false);
    const completed = createPollController({
      poll: completedPoll,
      fingerprint: (value) => value,
      baselineMs: 1_500,
      unchangedBackoffMs: [3_000, 6_000],
      pauseWhenHidden: true,
      onResult: completedResult,
      onError: vi.fn(),
      onStatus: vi.fn(),
    });
    completed.start();
    await advance(60_000);
    expect(completedPoll).toHaveBeenCalledOnce();

    const late = deferred<string>();
    const lateResult = vi.fn();
    const disposed = createPollController({
      poll: () => late.promise,
      fingerprint: (value) => value,
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: lateResult,
      onError: vi.fn(),
      onStatus: vi.fn(),
    });
    disposed.start();
    await advance(2_000);
    disposed.dispose();
    late.resolve("late");
    await advance(60_000);
    expect(lateResult).not.toHaveBeenCalled();
  });
});
