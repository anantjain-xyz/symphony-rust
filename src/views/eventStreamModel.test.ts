import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../bindings";
import { createEventStressFixture } from "../preview/eventStressFixture";
import { prepareEvent, prepareEvents, searchPreparedEvents } from "./eventStreamModel";

function event(id: number, kind: AgentEvent["kind"], payload: AgentEvent["payload"]): AgentEvent {
  return { id, run_id: "run-1", kind, payload, created_at: `2026-07-18T00:00:0${id}Z` };
}

describe("prepared event model", () => {
  it("renders opaque string payloads without a JSON parsing pass", () => {
    const parse = vi.spyOn(JSON, "parse");
    const prepared = prepareEvent(event(1, "status", "malformed {"));

    expect(prepared.event.payload).toBe("malformed {");
    expect(prepared.summary).toBe("malformed {");
    expect(prepared.prettyPayload).toBe("malformed {");
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("reuses deep-cloned rows, deduplicates IDs, and prunes stale cache entries without parsing", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      const cache = new Map();
      const firstRows = [
        event(1, "status", { message: "first" }),
        event(2, "status", { message: "second" }),
        event(2, "status", { message: "duplicate" }),
        event(3, "humanized", { summary: "twin" }),
      ];

      const first = prepareEvents(firstRows, cache);
      expect(parse).not.toHaveBeenCalled();
      const replacement = prepareEvents(
        firstRows.map((row) => structuredClone(row)),
        cache,
      );
      expect(replacement).toHaveLength(2);
      expect(replacement).toEqual(first);
      expect(replacement[0]).toBe(first[0]);
      expect(replacement[1]).toBe(first[1]);
      expect(parse).not.toHaveBeenCalled();

      const appended = prepareEvents([...firstRows, event(4, "status", "malformed {")], cache);
      expect(appended).toHaveLength(3);
      expect(appended.slice(0, 2)).toEqual(first);
      expect(appended[0]).toBe(first[0]);
      expect(appended[1]).toBe(first[1]);
      expect(appended[2].event.payload).toBe("malformed {");
      expect(appended[2].prettyPayload).toBe("malformed {");
      expect(parse).not.toHaveBeenCalled();

      const pruned = prepareEvents([firstRows[1]], cache);
      expect(cache.size).toBe(1);
      expect(pruned[0]).toBe(first[1]);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("invalidates a cached event when its structured payload changes", () => {
    const cache = new Map();
    const [first] = prepareEvents([event(1, "status", { message: "starting" })], cache);
    const [updated] = prepareEvents([event(1, "status", { message: "completed" })], cache);

    expect(updated).not.toBe(first);
    expect(updated.key).not.toBe(first.key);
    expect(updated.summary).toBe("completed");
    expect(searchPreparedEvents([updated], "starting").totalMatches).toBe(0);
    expect(searchPreparedEvents([updated], "completed").totalMatches).toBe(2);
  });

  it("returns every match across label, parsed Markdown, and payload in document order", () => {
    const cache = new Map();
    const prepared = prepareEvents(
      [
        event(1, "status", { message: "needle first needle" }),
        event(2, "error", { class: "NeedleError", message: "needle last" }),
      ],
      cache,
    );
    const result = searchPreparedEvents(prepared, "NeEdLe");

    expect(result.totalMatches).toBe(8);
    expect(
      Array.from({ length: result.totalMatches }, (_, index) => result.matchAt(index)),
    ).toEqual([
      { eventIndex: 0, section: "summary", localIndex: 0 },
      { eventIndex: 0, section: "summary", localIndex: 1 },
      { eventIndex: 0, section: "payload", localIndex: 0 },
      { eventIndex: 0, section: "payload", localIndex: 1 },
      { eventIndex: 1, section: "summary", localIndex: 0 },
      { eventIndex: 1, section: "summary", localIndex: 1 },
      { eventIndex: 1, section: "payload", localIndex: 0 },
      { eventIndex: 1, section: "payload", localIndex: 1 },
    ]);
    expect(result.matchSpans).toHaveLength(4);
    expect(searchPreparedEvents(prepared, "missing").totalMatches).toBe(0);
    expect(searchPreparedEvents(prepared, "NeedleError").totalMatches).toBe(2);
  });

  it("uses the same locale-independent case folding as rendered highlights", () => {
    const prepared = prepareEvents([event(1, "status", { message: "Istanbul" })], new Map());

    expect(searchPreparedEvents(prepared, "I").totalMatches).toBe(2);
  });

  it("stores compact section spans for high-frequency searches", () => {
    const prepared = prepareEvents(
      [event(1, "status", { message: "x ".repeat(5_000) })],
      new Map(),
    );
    const result = searchPreparedEvents(prepared, " ");

    expect(result.totalMatches).toBeGreaterThan(5_000);
    expect(result.matchSpans.length).toBeLessThanOrEqual(2);
    expect(result.matchAt(result.totalMatches - 1)).toEqual({
      eventIndex: 0,
      section: "payload",
      localIndex: expect.any(Number),
    });
  });

  it("provides a production-like 5,000-event fixture", () => {
    const fixture = createEventStressFixture();
    expect(fixture).toHaveLength(5_000);
    expect(
      fixture.some(
        (row) => typeof row.payload === "string" && row.payload.startsWith("malformed payload"),
      ),
    ).toBe(true);
    expect(
      fixture.some((row) => JSON.stringify(row.payload).includes("| Phase | Result | Detail |")),
    ).toBe(true);
    expect(new Set(fixture.map((row) => row.kind)).size).toBeGreaterThan(3);
  });
});
