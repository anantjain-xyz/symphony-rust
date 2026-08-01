import { describe, expect, it } from "vitest";
import { settingsSectionForScrollPosition } from "./SettingsView";

describe("settingsSectionForScrollPosition", () => {
  it("selects Workflow when the scroll container reaches its bottom", () => {
    expect(
      settingsSectionForScrollPosition({
        viewportTop: 64,
        scrollTop: 500,
        clientHeight: 500,
        scrollHeight: 1_000,
        sectionTops: {
          linear: -900,
          repositories: -500,
          runtime: 40,
          workflow: 320,
        },
      }),
    ).toBe("workflow");
  });

  it("does not force Workflow when all settings fit without scrolling", () => {
    expect(
      settingsSectionForScrollPosition({
        viewportTop: 64,
        scrollTop: 0,
        clientHeight: 1_000,
        scrollHeight: 1_000,
        sectionTops: {
          linear: 88,
          repositories: 260,
          runtime: 480,
          workflow: 720,
        },
      }),
    ).toBe("linear");
  });

  it("selects the latest stage above the activation line", () => {
    expect(
      settingsSectionForScrollPosition({
        viewportTop: 64,
        scrollTop: 420,
        clientHeight: 500,
        scrollHeight: 1_500,
        sectionTops: {
          linear: -340,
          repositories: 80,
          runtime: 460,
          workflow: 960,
        },
      }),
    ).toBe("repositories");
  });
});
