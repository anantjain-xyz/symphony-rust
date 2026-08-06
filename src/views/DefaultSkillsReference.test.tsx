// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as desktopCommands from "../desktop/commands";
import { DefaultSkillsReference } from "./SettingsView";

vi.mock("../desktop/commands", () => ({
  getDefaultSkills: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DefaultSkillsReference", () => {
  it("loads and shows the bundled skill contents without an editable control", async () => {
    vi.mocked(desktopCommands.getDefaultSkills).mockResolvedValue([
      {
        name: "symphony-test",
        content:
          "---\nname: symphony-test\ndescription: Follow the test workflow.\n---\n# Test skill\n\nRun the checks.",
      },
    ]);

    render(<DefaultSkillsReference runtimeAvailable />);

    fireEvent.click(screen.getByRole("button", { name: "View 7 default skills" }));
    expect(await screen.findByText("Follow the test workflow.")).toBeTruthy();

    fireEvent.click(screen.getByText("symphony-test"));
    const contents = screen.getByRole("region", { name: "symphony-test contents" });
    expect(contents.textContent).toContain("Run the checks.");
    expect(contents.querySelector("textarea, input")).toBeNull();
    expect(desktopCommands.getDefaultSkills).toHaveBeenCalledOnce();
  });
});
