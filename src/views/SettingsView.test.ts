import { describe, expect, it } from "vitest";
import {
  defaultSkillDescription,
  settingsNavigationOffset,
  settingsSectionForScrollPosition,
} from "./SettingsView";

describe("defaultSkillDescription", () => {
  it("reads the description from skill front matter", () => {
    expect(
      defaultSkillDescription(
        "---\nname: symphony-test\ndescription: Read-only reference.\n---\n# Test",
      ),
    ).toBe("Read-only reference.");
  });

  it("does not read description-like text outside front matter", () => {
    expect(defaultSkillDescription("# Test\n\ndescription: Body text")).toBeNull();
  });
});

describe("settingsNavigationOffset", () => {
  it("uses the sticky stepper height and layout gap at compact widths", () => {
    expect(
      settingsNavigationOffset({
        compact: true,
        viewportPaddingTop: 28,
        stickyTop: -1,
        stepperHeight: 49,
        layoutGap: 16,
      }),
    ).toBe(92);
  });

  it("keeps the desktop activation line compact", () => {
    expect(
      settingsNavigationOffset({
        compact: false,
        viewportPaddingTop: 28,
        stickyTop: 0,
        stepperHeight: 200,
        layoutGap: 28,
      }),
    ).toBe(24);
  });
});

describe("settingsSectionForScrollPosition", () => {
  it("selects Workflow when the scroll container reaches its bottom", () => {
    expect(
      settingsSectionForScrollPosition({
        viewportTop: 64,
        activationOffset: 24,
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
        activationOffset: 24,
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
        activationOffset: 24,
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

  it("uses the measured responsive navigation offset", () => {
    expect(
      settingsSectionForScrollPosition({
        viewportTop: 64,
        activationOffset: 92,
        scrollTop: 320,
        clientHeight: 500,
        scrollHeight: 1_500,
        sectionTops: {
          linear: -240,
          repositories: 156.4,
          runtime: 560,
          workflow: 1_020,
        },
      }),
    ).toBe("repositories");
  });
});
