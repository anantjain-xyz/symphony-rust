// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.0.0-test"),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

const bootstrap = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

if (!bootstrap) throw new Error("Theme bootstrap script not found in index.html");

type BootstrapCase = {
  name: string;
  stored?: string | null;
  storageThrows?: boolean;
  mediaDark?: boolean;
  mediaThrows?: boolean;
  expected: "light" | "dark";
};

const cases: BootstrapCase[] = [
  { name: "saved dark", stored: "dark", mediaThrows: true, expected: "dark" },
  { name: "saved light", stored: "light", mediaDark: true, expected: "light" },
  { name: "missing storage with dark system", stored: null, mediaDark: true, expected: "dark" },
  { name: "missing storage with light system", stored: null, mediaDark: false, expected: "light" },
  { name: "invalid storage with dark system", stored: "system", mediaDark: true, expected: "dark" },
  { name: "invalid storage with light system", stored: "invalid", mediaDark: false, expected: "light" },
  { name: "inaccessible storage", storageThrows: true, mediaDark: true, expected: "light" },
  { name: "unavailable matchMedia", stored: null, mediaThrows: true, expected: "light" },
];

function installBrowserState(testCase: BootstrapCase) {
  const setItem = vi.fn();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn(() => {
        if (testCase.storageThrows) throw new Error("storage unavailable");
        return testCase.stored ?? null;
      }),
      setItem,
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => {
      if (testCase.mediaThrows) throw new Error("matchMedia unavailable");
      return { matches: testCase.mediaDark ?? false };
    }),
  });
  return setItem;
}

function expectRootTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  expect(root.classList.contains("dark")).toBe(theme === "dark");
  expect(root.dataset.theme).toBe(theme);
  expect(root.style.colorScheme).toBe(theme);
}

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  vi.restoreAllMocks();
});

describe.each(cases)("theme bootstrap: $name", (testCase) => {
  it("applies the root theme before importing and rendering React", async () => {
    installBrowserState(testCase);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    window.eval(bootstrap);
    expectRootTheme(testCase.expected);

    const { default: App } = await import("./App");
    render(<App />);

    const toggleLabel =
      testCase.expected === "dark" ? "Switch to light theme" : "Switch to dark theme";
    expect(screen.getByRole("button", { name: toggleLabel })).toBeTruthy();
    expectRootTheme(testCase.expected);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

it("updates and persists every root theme surface when toggled both ways", async () => {
  const setItem = installBrowserState({ name: "toggle", stored: "dark", expected: "dark" });
  window.eval(bootstrap);

  const { default: App } = await import("./App");
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
  await waitFor(() => expectRootTheme("light"));
  expect(setItem).toHaveBeenLastCalledWith("symphony-theme", "light");

  fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
  await waitFor(() => expectRootTheme("dark"));
  expect(setItem).toHaveBeenLastCalledWith("symphony-theme", "dark");
});
