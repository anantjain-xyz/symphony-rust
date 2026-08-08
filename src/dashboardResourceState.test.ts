import { describe, expect, it, vi } from "vitest";
import {
  beginResourceRefresh,
  completeResourceRefresh,
  createResourceEnvelope,
  failResourceRefresh,
  markResourceDirty,
  normalizeResourceError,
  staleDirtyResource,
} from "./dashboardResourceState";

const START = "2026-07-18T12:00:00.000Z";

describe("dashboard resource envelopes", () => {
  it("preserves last-good data and timestamps when a refresh fails", () => {
    const ready = createResourceEnvelope(["last good"], START);
    const refreshing = beginResourceRefresh(ready, "2026-07-18T12:00:05.000Z");
    const failed = failResourceRefresh(
      refreshing,
      normalizeResourceError("Runs", new Error("offline")),
      "2026-07-18T12:00:06.000Z",
    );

    expect(failed.data).toEqual(["last good"]);
    expect(failed.status).toBe("stale");
    expect(failed.lastSuccessAt).toBe(START);
    expect(failed.lastAttemptAt).toBe("2026-07-18T12:00:05.000Z");
  });

  it("uses a scoped error without inventing empty data", () => {
    const failed = failResourceRefresh(
      beginResourceRefresh(createResourceEnvelope<string[]>(), START),
      normalizeResourceError("Issues", new Error("offline")),
      START,
    );

    expect(failed.data).toBeUndefined();
    expect(failed.status).toBe("error");
  });

  it("clears stale/error metadata only after a successful recovery", () => {
    const stale = failResourceRefresh(
      createResourceEnvelope(["old"], START),
      normalizeResourceError("Runs", new Error("offline")),
      "2026-07-18T12:00:01.000Z",
    );
    const retrying = beginResourceRefresh(stale, "2026-07-18T12:00:02.000Z");
    expect(retrying.error).not.toBeNull();

    const recovered = completeResourceRefresh(retrying, ["fresh"], "2026-07-18T12:00:03.000Z");
    expect(recovered).toMatchObject({
      data: ["fresh"],
      status: "ready",
      dirtySince: null,
      error: null,
      lastSuccessAt: "2026-07-18T12:00:03.000Z",
    });
  });

  it("marks only visible dirty resources stale at the 60-second boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const dirty = markResourceDirty(createResourceEnvelope("good", START), START);
    vi.advanceTimersByTime(59_999);
    expect(staleDirtyResource(dirty, Date.now(), true).status).toBe("ready");
    vi.advanceTimersByTime(1);
    expect(staleDirtyResource(dirty, Date.now(), false).status).toBe("ready");
    expect(staleDirtyResource(dirty, Date.now(), true).status).toBe("stale");
    vi.useRealTimers();
  });

  it("sanitizes secrets and settings from technical details", () => {
    const normalized = normalizeResourceError(
      "Overview",
      new Error(
        'Authorization: Bearer top-secret LINEAR_API_KEY=abc123 session_env: {"TOKEN":"hidden"}',
      ),
    );

    expect(normalized.summary).toBe("Overview could not be refreshed.");
    expect(normalized.technicalDetails).not.toContain("top-secret");
    expect(normalized.technicalDetails).not.toContain("abc123");
    expect(normalized.technicalDetails).not.toContain("hidden");
  });
});
