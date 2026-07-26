// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IssueRow } from "../bindings";

const graphMock = vi.hoisted(() => ({
  attempts: 0,
}));

vi.mock("./DependencyGraphPanel", () => {
  graphMock.attempts += 1;
  if (graphMock.attempts === 1) {
    throw new Error("dependency graph chunk unavailable");
  }
  return {
    default: () =>
      React.createElement("div", {
        role: "group",
        "aria-label": "Recovered dependency graph",
      }),
  };
});

import IssuesView from "./IssuesView";

const issue: IssueRow = {
  id: "issue-SYM-1",
  identifier: "SYM-1",
  title: "Title for SYM-1",
  description: null,
  priority: 2,
  state: "Todo",
  branch: null,
  labels: "[]",
  blockers: "[]",
  pr_urls: "[]",
  raw: "{}",
  last_seen_at: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("ends the busy state after import rejection and restores it only while retrying", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(
    <IssuesView
      issues={[issue]}
      linearWorkspace={null}
      onOpenSettings={() => undefined}
    />,
  );

  fireEvent.click(screen.getByRole("tab", { name: "Dependencies" }));

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Unable to load Dependency graph",
  );
  await waitFor(() =>
    expect(screen.getByRole("tabpanel").getAttribute("aria-busy")).toBe("false"),
  );

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByRole("tabpanel").getAttribute("aria-busy")).toBe("true");
  expect(
    await screen.findByRole("group", { name: "Recovered dependency graph" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("tabpanel").getAttribute("aria-busy")).toBe("false"),
  );
  expect(graphMock.attempts).toBe(2);
});
