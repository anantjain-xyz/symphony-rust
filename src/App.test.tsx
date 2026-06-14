// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("App settings", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("does not auto-capitalize repository names", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const repoNameInput = screen.getByLabelText(/^Name/, { selector: "input" });
    expect(repoNameInput.getAttribute("autocapitalize")).toBe("none");
  });

  it("shows the mycode launch wrapper in the launch command helper", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const example = screen.getByText("mycode --agent codex");
    expect(example.tagName.toLowerCase()).toBe("code");
    expect(example.getAttribute("class")).toBe("command-example");
  });
});
