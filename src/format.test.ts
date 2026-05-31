import { describe, expect, it } from "vitest";
import { nullable, prettyPayload } from "./format";

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
});
