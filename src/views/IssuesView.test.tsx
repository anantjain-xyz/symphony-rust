// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { IssueRow } from "../bindings";

const graphMocks = vi.hoisted(() => ({
  builds: vi.fn(),
  loads: vi.fn(),
  models: new WeakMap<readonly IssueRow[], true>(),
}));

vi.mock("./DependencyGraphPanel", () => {
  graphMocks.loads();
  return {
    default: ({ issues }: { issues: readonly IssueRow[] }) => {
      if (!graphMocks.models.has(issues)) {
        graphMocks.models.set(issues, true);
        graphMocks.builds(issues);
      }
      return React.createElement("div", { "aria-label": "Mock dependency graph" });
    },
  };
});

import IssuesView from "./IssuesView";

function issue(identifier: string): IssueRow {
  return {
    id: `issue-${identifier}`,
    identifier,
    title: `Title for ${identifier}`,
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
}

beforeEach(() => {
  graphMocks.builds.mockClear();
  graphMocks.loads.mockClear();
});

it("loads on preload, builds only while active, and caches by issues snapshot", async () => {
  const snapshot = [issue("SYM-1")];
  const { rerender } = render(
    <IssuesView
      issues={snapshot}
      linearWorkspace={null}
      initialMode="list"
      onOpenSettings={() => undefined}
    />,
  );

  expect(screen.getByText("Title for SYM-1")).toBeTruthy();
  expect(graphMocks.builds).not.toHaveBeenCalled();

  const dependencies = screen.getByRole("tab", { name: "Dependencies" });
  fireEvent.pointerEnter(dependencies);
  fireEvent.focus(dependencies);
  await waitFor(() => expect(graphMocks.loads).toHaveBeenCalledTimes(1));
  expect(graphMocks.builds).not.toHaveBeenCalled();

  fireEvent.click(dependencies);
  expect(await screen.findByLabelText("Mock dependency graph")).toBeTruthy();
  expect(graphMocks.builds).toHaveBeenCalledTimes(1);
  expect(graphMocks.builds).toHaveBeenLastCalledWith(snapshot);

  fireEvent.click(screen.getByRole("tab", { name: "List" }));
  expect(screen.queryByLabelText("Mock dependency graph")).toBeNull();

  rerender(
    <IssuesView
      issues={snapshot}
      linearWorkspace={null}
      initialMode="list"
      onOpenSettings={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Dependencies" }));
  expect(await screen.findByLabelText("Mock dependency graph")).toBeTruthy();
  expect(graphMocks.builds).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("tab", { name: "List" }));
  const replacement = [...snapshot];
  rerender(
    <IssuesView
      issues={replacement}
      linearWorkspace={null}
      initialMode="list"
      onOpenSettings={() => undefined}
    />,
  );
  expect(graphMocks.builds).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("tab", { name: "Dependencies" }));
  expect(await screen.findByLabelText("Mock dependency graph")).toBeTruthy();
  expect(graphMocks.builds).toHaveBeenCalledTimes(2);
  expect(graphMocks.builds).toHaveBeenLastCalledWith(replacement);
});
