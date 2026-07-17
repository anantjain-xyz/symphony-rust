export type PollPhase = "scheduled" | "polling" | "paused" | "stopped";

export type PollResourceState = {
  phase: PollPhase;
  stale: boolean;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  error: unknown | null;
};

type PollControllerOptions<T> = {
  poll: () => Promise<T>;
  fingerprint: (value: T) => string;
  baselineMs: number;
  unchangedBackoffMs: readonly number[];
  pauseWhenHidden: boolean;
  failureMaxMs?: number;
  onResult: (value: T) => boolean | void;
  onError?: (error: unknown) => void;
  onStatus: (status: PollResourceState) => void;
  document?: Pick<Document, "addEventListener" | "hidden" | "removeEventListener">;
  now?: () => number;
};

export type PollController = {
  start: () => void;
  reset: () => void;
  dispose: () => void;
};

const FAILURE_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

export function createPollController<T>({
  poll,
  fingerprint,
  baselineMs,
  unchangedBackoffMs,
  pauseWhenHidden,
  failureMaxMs = 30_000,
  onResult,
  onError,
  onStatus,
  document: pollDocument = globalThis.document,
  now = Date.now,
}: PollControllerOptions<T>): PollController {
  let disposed = false;
  let started = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFingerprint: string | null = null;
  let unchangedCount = 0;
  let consecutiveFailures = 0;
  let resetAfterSettlement = false;
  let immediateAfterSettlement = false;
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
  let lastError: unknown | null = null;

  const hidden = () => pauseWhenHidden && pollDocument.hidden;

  const publish = (phase: PollPhase) => {
    if (disposed) return;
    onStatus({
      phase,
      stale: consecutiveFailures > 0,
      consecutiveFailures,
      lastSuccessAt,
      lastFailureAt,
      error: lastError,
    });
  };

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const unchangedDelay = () => {
    if (unchangedCount < 3 || unchangedBackoffMs.length === 0) return baselineMs;
    return unchangedBackoffMs[
      Math.min(unchangedCount - 3, unchangedBackoffMs.length - 1)
    ];
  };

  const failureDelay = () =>
    Math.min(
      FAILURE_DELAYS_MS[
        Math.min(consecutiveFailures - 1, FAILURE_DELAYS_MS.length - 1)
      ],
      failureMaxMs,
    );

  const schedule = (delayMs: number) => {
    if (disposed || !started) return;
    clearTimer();
    if (hidden()) {
      publish("paused");
      return;
    }
    timer = setTimeout(run, delayMs);
    publish("scheduled");
  };

  const settleAndSchedule = (delayMs: number) => {
    inFlight = false;
    if (disposed || !started) return;
    if (hidden()) {
      immediateAfterSettlement = true;
      publish("paused");
      return;
    }
    if (immediateAfterSettlement) {
      immediateAfterSettlement = false;
      schedule(0);
      return;
    }
    if (resetAfterSettlement) {
      resetAfterSettlement = false;
      schedule(baselineMs);
      return;
    }
    schedule(delayMs);
  };

  async function run() {
    timer = null;
    if (disposed || !started || inFlight) return;
    if (hidden()) {
      publish("paused");
      return;
    }
    inFlight = true;
    publish("polling");
    try {
      const value = await poll();
      if (disposed || !started) return;
      const nextFingerprint = fingerprint(value);
      if (lastFingerprint === nextFingerprint) {
        unchangedCount += 1;
      } else {
        lastFingerprint = nextFingerprint;
        unchangedCount = 0;
      }
      consecutiveFailures = 0;
      lastError = null;
      lastSuccessAt = now();
      const shouldContinue = onResult(value) !== false;
      if (!shouldContinue) {
        dispose();
        return;
      }
      settleAndSchedule(unchangedDelay());
    } catch (error) {
      if (disposed || !started) return;
      consecutiveFailures += 1;
      lastError = error;
      lastFailureAt = now();
      onError?.(error);
      settleAndSchedule(failureDelay());
    }
  }

  const onVisibilityChange = () => {
    if (disposed || !started || !pauseWhenHidden) return;
    if (pollDocument.hidden) {
      clearTimer();
      if (inFlight) immediateAfterSettlement = true;
      publish("paused");
      return;
    }
    if (inFlight) {
      immediateAfterSettlement = true;
      return;
    }
    schedule(0);
  };

  pollDocument.addEventListener("visibilitychange", onVisibilityChange);

  function dispose() {
    if (disposed) return;
    disposed = true;
    started = false;
    clearTimer();
    pollDocument.removeEventListener("visibilitychange", onVisibilityChange);
  }

  return {
    start() {
      if (disposed || started) return;
      started = true;
      schedule(baselineMs);
    },
    reset() {
      if (disposed || !started) return;
      lastFingerprint = null;
      unchangedCount = 0;
      consecutiveFailures = 0;
      lastError = null;
      clearTimer();
      if (inFlight) {
        resetAfterSettlement = true;
        return;
      }
      schedule(baselineMs);
    },
    dispose,
  };
}
