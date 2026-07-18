import { describe, expect, it, vi } from "vitest";
import type { AgentEventRow } from "../bindings";
import { createEventStressFixture } from "../preview/eventStressFixture";
import {
  prepareEvents,
  searchPreparedEvents,
  type PreparedEvent,
} from "./eventStreamModel";

function event(id: number, kind: string, payload: string): AgentEventRow {
  return { id, run_id: "run-1", kind, payload, created_at: `2026-07-18T00:00:0${id}Z` };
}

describe("prepared event model", () => {
  it("parses each stable revision once, reuses cloned rows, deduplicates IDs, and prunes stale cache entries", () => {
    const parsedPayload = vi.fn();
    const parsedMarkdown = vi.fn();
    const instrumentation = { parsedPayload, parsedMarkdown };
    const cache = new Map<string, PreparedEvent>();
    const firstRows = [
      event(1, "status", '{"message":"first"}'),
      event(2, "status", '{"message":"second"}'),
      event(2, "status", '{"message":"duplicate"}'),
      event(3, "humanized", '{"summary":"twin"}'),
    ];

    const first = prepareEvents(firstRows, cache, instrumentation);
    const replacement = prepareEvents(firstRows.map((row) => ({ ...row })), cache, instrumentation);
    expect(replacement).toHaveLength(2);
    expect(replacement[0]).toBe(first[0]);
    expect(replacement[1]).toBe(first[1]);
    expect(parsedPayload).toHaveBeenCalledTimes(2);
    expect(parsedMarkdown).toHaveBeenCalledTimes(2);

    const appended = prepareEvents([...firstRows, event(4, "status", "malformed {")], cache, instrumentation);
    expect(appended).toHaveLength(3);
    expect(appended[2].parsedJson).toBeUndefined();
    expect(appended[2].prettyPayload).toBe("malformed {");
    expect(parsedPayload).toHaveBeenCalledTimes(3);
    expect(parsedMarkdown).toHaveBeenCalledTimes(3);

    prepareEvents([firstRows[1]], cache, instrumentation);
    expect(cache.size).toBe(1);
  });

  it("returns every match across label, parsed Markdown, and payload in document order", () => {
    const cache = new Map<string, PreparedEvent>();
    const prepared = prepareEvents(
      [
        event(1, "status", '{"message":"needle first needle"}'),
        event(2, "error", '{"class":"NeedleError","message":"needle last"}'),
      ],
      cache,
    );
    const result = searchPreparedEvents(prepared, "NeEdLe");

    expect(result.matches).toEqual([
      { eventIndex: 0, section: "summary", localIndex: 0 },
      { eventIndex: 0, section: "summary", localIndex: 1 },
      { eventIndex: 0, section: "payload", localIndex: 0 },
      { eventIndex: 0, section: "payload", localIndex: 1 },
      { eventIndex: 1, section: "summary", localIndex: 0 },
      { eventIndex: 1, section: "summary", localIndex: 1 },
      { eventIndex: 1, section: "payload", localIndex: 0 },
      { eventIndex: 1, section: "payload", localIndex: 1 },
    ]);
    expect(searchPreparedEvents(prepared, "missing").matches).toEqual([]);
    expect(searchPreparedEvents(prepared, "NeedleError").matches).toHaveLength(2);
  });

  it("provides a production-like 5,000-event fixture", () => {
    const fixture = createEventStressFixture();
    expect(fixture).toHaveLength(5_000);
    expect(fixture.some((row) => row.payload.startsWith("malformed payload"))).toBe(true);
    expect(fixture.some((row) => row.payload.includes("| Phase | Result | Detail |"))).toBe(true);
    expect(new Set(fixture.map((row) => row.kind)).size).toBeGreaterThan(3);
  });
});
