import { describe, expect, it } from "vitest";
import {
  describeEvent,
  formatTokens,
  nullable,
  prettyPayload,
  priorityLabel,
  relativeTime,
  statusSlug,
  timeOnly,
} from "./format";

describe("format helpers", () => {
  it("normalizes blank optional fields to null", () => {
    expect(nullable("")).toBeNull();
    expect(nullable("   ")).toBeNull();
    expect(nullable("SYM-")).toBe("SYM-");
  });

  it("pretty prints JSON payloads", () => {
    expect(prettyPayload('{"message":"ok"}')).toContain('"message": "ok"');
    expect(prettyPayload("not json")).toBe("not json");
  });

  it("renders relative times for past and future", () => {
    const now = Date.UTC(2026, 5, 10, 12, 0, 0);
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(relativeTime(at(-10_000), now)).toBe("just now");
    expect(relativeTime(at(-12 * 60_000), now)).toBe("12m ago");
    expect(relativeTime(at(9 * 60_000), now)).toBe("in 9m");
    expect(relativeTime(at(-3 * 3_600_000), now)).toBe("3h ago");
    expect(relativeTime(at(-2 * 86_400_000), now)).toBe("2d ago");
    expect(relativeTime("not a date", now)).toBe("not a date");
  });

  it("falls back to a date for ages older than a week", () => {
    const now = Date.UTC(2026, 5, 10, 12, 0, 0);
    const old = new Date(now - 30 * 86_400_000).toISOString();
    expect(relativeTime(old, now)).not.toContain("ago");
  });

  it("abbreviates token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(9_281)).toBe("9.3k");
    expect(formatTokens(184_223)).toBe("184k");
    expect(formatTokens(1_350_000)).toBe("1.4M");
  });

  it("maps Linear priorities to labels", () => {
    expect(priorityLabel(0)).toBe("None");
    expect(priorityLabel(1)).toBe("Urgent");
    expect(priorityLabel(4)).toBe("Low");
    expect(priorityLabel(9)).toBe("9");
  });

  it("slugs issue states for badge classes", () => {
    expect(statusSlug("In Progress")).toBe("in-progress");
    expect(statusSlug("Done")).toBe("done");
  });

  it("passes invalid dates through timeOnly", () => {
    expect(timeOnly("not a date")).toBe("not a date");
    expect(timeOnly("2026-06-10T12:30:00Z")).toMatch(/\d/);
  });

  it("summarizes known agent events", () => {
    expect(describeEvent("status", '{"message":"cloning repo"}')).toEqual({
      label: "Status",
      summary: "cloning repo",
    });
    expect(
      describeEvent(
        "tool_call",
        '{"tool":"bash","args":{"command":"pnpm test"},"result_summary":"exit 0"}',
      ),
    ).toEqual({ label: "Tool call", summary: "bash: exit 0" });
    expect(
      describeEvent("tool_call", '{"tool":"bash","args":{"command":"pnpm test"}}'),
    ).toEqual({ label: "Tool call", summary: "bash: pnpm test" });
    expect(
      describeEvent("token_count", '{"input_tokens":184223,"output_tokens":9281}'),
    ).toEqual({ label: "Tokens", summary: "184k in · 9.3k out" });
    expect(
      describeEvent("error", '{"class":"AgentTurnTimeout","message":"turn exceeded budget"}'),
    ).toEqual({
      label: "Error",
      summary: "AgentTurnTimeout: turn exceeded budget",
      tone: "error",
    });
    expect(
      describeEvent("rate_limit", '{"source":"codex","remaining":12}'),
    ).toEqual({ label: "Rate limit", summary: "codex — 12 remaining" });
  });

  it("falls back gracefully for unknown or malformed events", () => {
    expect(describeEvent("status", "not json")).toEqual({
      label: "Status",
      summary: "not json",
    });
    expect(describeEvent("mystery.kind", '{"a":1}')).toEqual({
      label: "mystery.kind",
      summary: "",
    });
  });
});
