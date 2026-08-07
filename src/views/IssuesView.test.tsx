// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueRow, WorkflowStateRow } from "../bindings";

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

import IssuesView, {
  BOARD_COLUMN_PAGE_SIZE,
  BOARD_REFRESH_INTERVAL_MS,
  boardDragScrollDelta,
  boardColumns,
} from "./IssuesView";

function issue(identifier: string, state = "Todo", priority = 2): IssueRow {
  return {
    id: `issue-${identifier}`,
    identifier,
    title: `Title for ${identifier}`,
    description: null,
    priority,
    state,
    branch: null,
    labels: "[]",
    blockers: "[]",
    pr_urls: "[]",
    raw: "{}",
    last_seen_at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  cleanup();
  graphMocks.builds.mockClear();
  graphMocks.loads.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
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

it("groups issues into board columns ordered by workflow state", () => {
  const issues = [
    // Tracker lowercases every state name; configured columns are Title Case.
    issue("SYM-3", "done"),
    issue("SYM-1", "in progress", 1),
    issue("SYM-2", "todo"),
    issue("SYM-4", "in progress", 3),
  ];
  render(
    <IssuesView
      issues={issues}
      linearWorkspace="acme"
      stateOrder={["Todo", "In Progress", "Rework", "Merging", "Done", "Canceled"]}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  // Columns render for every configured state, including empty ones, in order.
  const columns = screen.getAllByRole("region").map((node) => node.getAttribute("aria-label"));
  expect(columns).toEqual([
    "Todo (1)",
    "In Progress (2)",
    "Rework (0)",
    "Merging (0)",
    "Done (1)",
    "Canceled (0)",
  ]);

  // The dependency graph is never loaded for the board view.
  expect(graphMocks.builds).not.toHaveBeenCalled();

  // Within a column, urgent priority sorts ahead of lower priority.
  const inProgress = screen.getByRole("region", { name: "In Progress (2)" });
  const cardIds = Array.from(inProgress.querySelectorAll(".issue-card strong")).map(
    (node) => node.textContent,
  );
  expect(cardIds).toEqual(["SYM-1", "SYM-4"]);

  // Each card exposes an Open-in-Linear affordance when a workspace is configured.
  expect(screen.getByLabelText("Open SYM-1 in Linear")).toBeTruthy();
});

it("appends unconfigured states as trailing board columns", () => {
  render(
    <IssuesView
      issues={[issue("SYM-9", "backlog")]}
      linearWorkspace={null}
      stateOrder={["Todo"]}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );
  const columns = screen.getAllByRole("region").map((node) => node.getAttribute("aria-label"));
  expect(columns).toEqual(["Todo (0)", "Backlog (1)"]);
});

const workflowStates: WorkflowStateRow[] = [
  { id: "state-in-progress", name: "In Progress", state_type: "started", position: 2 },
  { id: "state-todo", name: "Todo", state_type: "unstarted", position: 1 },
];

it("boardColumns orders lanes by workflow position and honors overrides", () => {
  const issues = [issue("SYM-1", "todo"), issue("SYM-2", "in progress")];
  const columns = boardColumns(issues, { workflowStates });
  // Sorted by position, not the array order, and carrying the Linear state ids.
  expect(columns.map((column) => column.label)).toEqual(["Todo", "In Progress"]);
  expect(columns.map((column) => column.id)).toEqual(["state-todo", "state-in-progress"]);
  expect(columns[0].issues.map((row) => row.identifier)).toEqual(["SYM-1"]);

  // An override relocates the issue without mutating the underlying issue row.
  const overrides = new Map([["issue-SYM-1", { target: "in progress", from: "todo" }]]);
  const moved = boardColumns(issues, { workflowStates, overrides });
  expect(
    moved.find((column) => column.key === "in progress")?.issues.map((row) => row.identifier),
  ).toEqual(["SYM-1", "SYM-2"]);
  expect(moved.find((column) => column.key === "todo")?.issues).toHaveLength(0);
});

it("boardColumns falls back to stateOrder and appends unknown states", () => {
  const columns = boardColumns([issue("SYM-9", "backlog")], { stateOrder: ["Todo"] });
  expect(columns.map((column) => column.label)).toEqual(["Todo", "Backlog"]);
  // Fallback lanes have no Linear state id, so they are not drop targets.
  expect(columns.every((column) => column.id === null)).toBe(true);
});

it("scrolls the board toward columns near either horizontal edge", () => {
  expect(boardDragScrollDelta(120, 100, 500)).toBeLessThan(0);
  expect(boardDragScrollDelta(300, 100, 500)).toBe(0);
  expect(boardDragScrollDelta(480, 100, 500)).toBeGreaterThan(0);
});

async function dragCardToColumn(card: HTMLElement, column: HTMLElement, expectActive = true) {
  // Pointer-based drag (matches the WKWebView-safe implementation).
  fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  // Cross the movement threshold on window to activate the drag.
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 60 });
  if (expectActive) {
    await waitFor(() => {
      // Retry until the effect-backed global pointer listener is attached.
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 60 });
      expect(document.querySelector(".issue-drag-ghost")).toBeTruthy();
    });
  }
  // Move over the target lane so it becomes the hovered drop target.
  fireEvent.pointerMove(column, { pointerId: 1, clientX: 200, clientY: 80 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 80 });
}

it("moves a card to another workflow lane via drag and drop", async () => {
  const onMoveIssue = vi.fn().mockResolvedValue(undefined);
  render(
    <IssuesView
      issues={[issue("SYM-1", "todo")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      onMoveIssue={onMoveIssue}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  // Lanes are fetched from the team workflow states.
  const inProgress = await screen.findByRole("region", { name: "In Progress (0)" });
  const todo = screen.getByRole("region", { name: "Todo (1)" });
  const card = todo.querySelector(".issue-card") as HTMLElement;
  expect(card).toBeTruthy();

  await dragCardToColumn(card, inProgress);

  expect(onMoveIssue).toHaveBeenCalledWith("issue-SYM-1", "state-in-progress");
  // Optimistic move: the card is now under In Progress.
  await waitFor(() => expect(screen.getByRole("region", { name: "In Progress (1)" })).toBeTruthy());
  expect(screen.getByRole("region", { name: "Todo (0)" })).toBeTruthy();
});

it("auto-scrolls horizontally while dragging near the board edge", async () => {
  render(
    <IssuesView
      issues={[issue("SYM-1", "todo")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      onMoveIssue={() => Promise.resolve()}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const todo = await screen.findByRole("region", { name: "Todo (1)" });
  const boardBody = todo.closest(".issue-board-body") as HTMLElement;
  Object.defineProperties(boardBody, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 900 },
  });
  vi.spyOn(boardBody, "getBoundingClientRect").mockReturnValue({
    bottom: 400,
    height: 300,
    left: 0,
    right: 300,
    top: 100,
    width: 300,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  });
  const frames: FrameRequestCallback[] = [];
  const requestFrame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => frames.push(callback));
  const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  const pointerEvent = (type: string, clientX: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      button: { value: 0 },
      clientX: { value: clientX },
      clientY: { value: 150 },
      pointerId: { value: 7 },
    });
    return event;
  };

  const card = todo.querySelector(".issue-card") as HTMLElement;
  try {
    fireEvent(card, pointerEvent("pointerdown", 100));
    await waitFor(() => {
      // Retry until the effect-backed global pointer listener is attached.
      fireEvent(window, pointerEvent("pointermove", 295));
      expect(frames).toHaveLength(1);
    });

    frames.shift()?.(0);
    expect(boardBody.scrollLeft).toBeGreaterThan(0);
  } finally {
    fireEvent(window, pointerEvent("pointerup", 295));
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  }
});

it("reverts the card and surfaces an error when the move fails", async () => {
  const onMoveIssue = vi.fn().mockRejectedValue(new Error("network down"));
  render(
    <IssuesView
      issues={[issue("SYM-1", "todo")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      onMoveIssue={onMoveIssue}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const inProgress = await screen.findByRole("region", { name: "In Progress (0)" });
  const card = screen
    .getByRole("region", { name: "Todo (1)" })
    .querySelector(".issue-card") as HTMLElement;

  await dragCardToColumn(card, inProgress);

  // The failure is surfaced and the card rolls back to its original lane.
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByRole("region", { name: "Todo (1)" })).toBeTruthy());
  expect(screen.getByRole("region", { name: "In Progress (0)" })).toBeTruthy();
});

const sampleWorkflowStates: WorkflowStateRow[] = [
  { id: "s-done", name: "Done", state_type: "completed", position: 3 },
  { id: "s-canceled", name: "Canceled", state_type: "canceled", position: 4 },
  { id: "s-backlog", name: "Backlog", state_type: "backlog", position: 0 },
  { id: "s-inreview", name: "In Review", state_type: "started", position: 1002 },
  { id: "s-todo", name: "Todo", state_type: "unstarted", position: 1 },
  { id: "s-duplicate", name: "Duplicate", state_type: "duplicate", position: 5 },
  { id: "s-inprogress", name: "In Progress", state_type: "started", position: 2 },
];

it("orders lanes by state category then position, matching Linear", () => {
  const columns = boardColumns([], { workflowStates: sampleWorkflowStates });
  // In Review (position 1002) still sits with the other started states, not last.
  expect(columns.map((column) => column.label)).toEqual([
    "Backlog",
    "Todo",
    "In Progress",
    "In Review",
    "Done",
    "Canceled",
    "Duplicate",
  ]);
});

it("renders all board lanes as columns, including Linear's backlog/terminal states", async () => {
  render(
    <IssuesView
      issues={[issue("ENG-99", "todo")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(sampleWorkflowStates)}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  await screen.findByRole("region", { name: "Todo (1)" });
  expect(screen.getByRole("region", { name: "Backlog (0)" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Done (0)" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Canceled (0)" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Duplicate (0)" })).toBeTruthy();
});

it("mounts board cards in bounded pages while keeping the full lane count visible", async () => {
  const doneIssues = Array.from({ length: BOARD_COLUMN_PAGE_SIZE + 1 }, (_, index) =>
    issue(`DONE-${index + 1}`, "done"),
  );
  render(
    <IssuesView
      issues={doneIssues}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(sampleWorkflowStates)}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const done = await screen.findByRole("region", {
    name: `Done (${BOARD_COLUMN_PAGE_SIZE + 1})`,
  });
  expect(done.querySelectorAll(".issue-card")).toHaveLength(BOARD_COLUMN_PAGE_SIZE);

  fireEvent.click(screen.getByRole("button", { name: "Show more issues in Done" }));
  expect(done.querySelectorAll(".issue-card")).toHaveLength(BOARD_COLUMN_PAGE_SIZE + 1);
});

it("populates lanes from live board issues, not only watched issues", async () => {
  render(
    <IssuesView
      issues={[]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(sampleWorkflowStates)}
      loadBoardIssues={() => Promise.resolve([issue("ENG-98", "in review", 1)])}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  // ENG-98 is In Review — a state the worker doesn't watch — yet the board shows it.
  await waitFor(() => expect(screen.getByRole("region", { name: "In Review (1)" })).toBeTruthy());
  const inReview = screen.getByRole("region", { name: "In Review (1)" });
  expect(inReview.querySelector(".issue-card strong")?.textContent).toBe("ENG-98");
});

it("does not start a drag from the Open-in-Linear control", () => {
  const onMoveIssue = vi.fn().mockResolvedValue(undefined);
  render(
    <IssuesView
      issues={[issue("SYM-1", "todo")]}
      linearWorkspace="acme"
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      onMoveIssue={onMoveIssue}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const openButton = screen.getByLabelText("Open SYM-1 in Linear");
  fireEvent.pointerDown(openButton, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 80, clientY: 80 });
  fireEvent.pointerUp(window, { pointerId: 2, clientX: 80, clientY: 80 });
  expect(onMoveIssue).not.toHaveBeenCalled();
});

it("shows an Updated stamp and supports manual refresh", async () => {
  const loadBoardIssues = vi.fn().mockResolvedValue([]);
  const { container } = render(
    <IssuesView
      issues={[]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      loadBoardIssues={loadBoardIssues}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  // Initial poll runs on mount and stamps the board.
  await waitFor(() => expect(loadBoardIssues).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(container.querySelector(".issue-board-updated")?.textContent).toContain("Updated"),
  );

  // Manual refresh triggers another fetch.
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await waitFor(() => expect(loadBoardIssues).toHaveBeenCalledTimes(2));
});

it("re-polls board issues on the refresh interval", async () => {
  vi.useFakeTimers();
  const loadBoardIssues = vi.fn().mockResolvedValue([]);
  render(
    <IssuesView
      issues={[]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      loadBoardIssues={loadBoardIssues}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  await vi.advanceTimersByTimeAsync(0);
  expect(loadBoardIssues).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(BOARD_REFRESH_INTERVAL_MS);
  expect(loadBoardIssues).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(BOARD_REFRESH_INTERVAL_MS);
  expect(loadBoardIssues).toHaveBeenCalledTimes(3);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("keeps watched issues when the live board fetch returns empty (#1)", async () => {
  const { container } = render(
    <IssuesView
      issues={[issue("SYM-1", "todo")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      loadBoardIssues={() => Promise.resolve([])}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  // Wait for the empty board response to land, then confirm the watched issue survives.
  await waitFor(() =>
    expect(container.querySelector(".issue-board-updated")?.textContent).toContain("Updated"),
  );
  expect(screen.getByRole("region", { name: "Todo (1)" })).toBeTruthy();
});

it("blocks moving an issue that has an active agent run (#5)", async () => {
  const onMoveIssue = vi.fn().mockResolvedValue(undefined);
  render(
    <IssuesView
      issues={[issue("SYM-1", "todo")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      onMoveIssue={onMoveIssue}
      activeRunIssueIds={["issue-SYM-1"]}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const inProgress = await screen.findByRole("region", { name: "In Progress (0)" });
  const card = screen
    .getByRole("region", { name: "Todo (1)" })
    .querySelector(".issue-card") as HTMLElement;
  await dragCardToColumn(card, inProgress);

  await screen.findByRole("alert");
  expect(onMoveIssue).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Todo (1)" })).toBeTruthy();
});

it("locks a card from a second move while the first is pending (#3)", async () => {
  const pending = deferred<void>();
  const onMoveIssue = vi.fn().mockReturnValue(pending.promise);
  render(
    <IssuesView
      issues={[issue("SYM-1", "todo")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      onMoveIssue={onMoveIssue}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const inProgress = await screen.findByRole("region", { name: "In Progress (0)" });
  const card = screen
    .getByRole("region", { name: "Todo (1)" })
    .querySelector(".issue-card") as HTMLElement;
  await dragCardToColumn(card, inProgress);
  expect(onMoveIssue).toHaveBeenCalledTimes(1);

  // Optimistically moved and pending — a second drag must be a no-op.
  await waitFor(() => expect(screen.getByRole("region", { name: "In Progress (1)" })).toBeTruthy());
  const pendingCard = screen
    .getByRole("region", { name: "In Progress (1)" })
    .querySelector(".issue-card") as HTMLElement;
  await dragCardToColumn(pendingCard, screen.getByRole("region", { name: "Todo (0)" }), false);
  expect(onMoveIssue).toHaveBeenCalledTimes(1);

  pending.resolve();
});

it("coalesces board polls — no concurrent fetch while one is in flight (#2/#5)", async () => {
  vi.useFakeTimers();
  const pending = deferred<IssueRow[]>();
  const loadBoardIssues = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
  render(
    <IssuesView
      issues={[]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(workflowStates)}
      loadBoardIssues={loadBoardIssues}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  await vi.advanceTimersByTimeAsync(0);
  expect(loadBoardIssues).toHaveBeenCalledTimes(1);
  // Interval ticks while the first fetch is still pending must NOT stack new fetches.
  await vi.advanceTimersByTimeAsync(BOARD_REFRESH_INTERVAL_MS * 3);
  expect(loadBoardIssues).toHaveBeenCalledTimes(1);

  // Once it resolves, the next tick is free to poll again.
  pending.resolve([]);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(BOARD_REFRESH_INTERVAL_MS);
  expect(loadBoardIssues).toHaveBeenCalledTimes(2);
});

const threeStates: WorkflowStateRow[] = [
  { id: "state-todo", name: "Todo", state_type: "unstarted", position: 1 },
  { id: "state-in-progress", name: "In Progress", state_type: "started", position: 2 },
  { id: "state-in-review", name: "In Review", state_type: "started", position: 1002 },
];

it("clears an override when Linear advances the issue past the target (#1)", async () => {
  const boardSnapshots = [[issue("SYM-1", "todo")], [issue("SYM-1", "in review")]];
  let call = 0;
  const loadBoardIssues = vi.fn(() =>
    Promise.resolve(boardSnapshots[Math.min(call++, boardSnapshots.length - 1)]),
  );
  const onMoveIssue = vi.fn().mockResolvedValue(undefined);
  render(
    <IssuesView
      issues={[]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(threeStates)}
      loadBoardIssues={loadBoardIssues}
      onMoveIssue={onMoveIssue}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const inProgress = await screen.findByRole("region", { name: "In Progress (0)" });
  await waitFor(() => expect(screen.getByRole("region", { name: "Todo (1)" })).toBeTruthy());
  const card = screen
    .getByRole("region", { name: "Todo (1)" })
    .querySelector(".issue-card") as HTMLElement;

  // Drag Todo -> In Progress; the post-move re-pull reports it already advanced to In Review.
  await dragCardToColumn(card, inProgress);
  await waitFor(() => expect(onMoveIssue).toHaveBeenCalledWith("issue-SYM-1", "state-in-progress"));

  // The override must not pin the card to In Progress; it follows Linear to In Review.
  await waitFor(() => expect(screen.getByRole("region", { name: "In Review (1)" })).toBeTruthy());
  expect(screen.getByRole("region", { name: "In Progress (0)" })).toBeTruthy();
});

it("confirms a drop that crosses into a watched (dispatch) state (#2)", async () => {
  const onMoveIssue = vi.fn().mockResolvedValue(undefined);
  render(
    <IssuesView
      issues={[issue("SYM-1", "in review")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(threeStates)}
      onMoveIssue={onMoveIssue}
      activeStates={["Todo", "In Progress"]}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const inProgress = await screen.findByRole("region", { name: "In Progress (0)" });
  const card = screen
    .getByRole("region", { name: "In Review (1)" })
    .querySelector(".issue-card") as HTMLElement;

  await dragCardToColumn(card, inProgress);
  // Crossing into a watched lane must confirm rather than mutate immediately.
  await screen.findByRole("alertdialog");
  expect(onMoveIssue).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  await waitFor(() => expect(onMoveIssue).toHaveBeenCalledWith("issue-SYM-1", "state-in-progress"));
});

it("cancels a boundary-crossing move without calling Linear (#2)", async () => {
  const onMoveIssue = vi.fn().mockResolvedValue(undefined);
  render(
    <IssuesView
      issues={[issue("SYM-1", "in review")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(threeStates)}
      onMoveIssue={onMoveIssue}
      activeStates={["Todo", "In Progress"]}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const inProgress = await screen.findByRole("region", { name: "In Progress (0)" });
  const card = screen
    .getByRole("region", { name: "In Review (1)" })
    .querySelector(".issue-card") as HTMLElement;

  await dragCardToColumn(card, inProgress);
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(onMoveIssue).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("region", { name: "In Review (1)" })).toBeTruthy();
});

it("marks watched (dispatch) lanes (#2)", async () => {
  render(
    <IssuesView
      issues={[]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(threeStates)}
      activeStates={["Todo", "In Progress"]}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const todo = await screen.findByRole("region", { name: "Todo (0)" });
  expect(todo.querySelector(".issue-board-watched")).toBeTruthy();
  const inReview = screen.getByRole("region", { name: "In Review (0)" });
  expect(inReview.querySelector(".issue-board-watched")).toBeNull();
});

it("keeps a card locked from a second move until the first reconciles (chained-move race)", async () => {
  const onMoveIssue = vi.fn().mockResolvedValue(undefined);
  render(
    <IssuesView
      issues={[issue("SYM-1", "todo")]}
      linearWorkspace={null}
      loadWorkflowStates={() => Promise.resolve(threeStates)}
      onMoveIssue={onMoveIssue}
      initialMode="board"
      onOpenSettings={() => undefined}
    />,
  );

  const inProgress = await screen.findByRole("region", { name: "In Progress (0)" });
  const card = screen
    .getByRole("region", { name: "Todo (1)" })
    .querySelector(".issue-card") as HTMLElement;
  await dragCardToColumn(card, inProgress);
  await waitFor(() => expect(onMoveIssue).toHaveBeenCalledTimes(1));

  // Wait until the mutation settles (no more "moving"), so only the still-pending
  // override — not movingIds — can be locking the card.
  await waitFor(() => {
    const moved = screen
      .getByRole("region", { name: "In Progress (1)" })
      .querySelector(".issue-card") as HTMLElement;
    expect(moved.classList.contains("moving")).toBe(false);
  });

  const moved = screen
    .getByRole("region", { name: "In Progress (1)" })
    .querySelector(".issue-card") as HTMLElement;
  // A second move must be blocked until the first reconciles (prevents stale-poll revert).
  await dragCardToColumn(moved, screen.getByRole("region", { name: "In Review (0)" }), false);
  expect(onMoveIssue).toHaveBeenCalledTimes(1);
});
