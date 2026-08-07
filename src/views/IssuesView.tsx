import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { IssueRow, WorkflowStateRow } from "../bindings";
import { ChunkErrorBoundary, createLazyAttempts } from "../ChunkBoundary";
import { openExternalUrl } from "../desktop/shell";
import { priorityLabel, statusSlug } from "../format";
import { markRelativeTimeNow, RelativeTime } from "../RelativeTime";
import "./IssuesView.css";

export type IssueViewMode = "list" | "board" | "dependencies";

const BOARD_DRAG_EDGE_SIZE = 48;
const BOARD_DRAG_MAX_SCROLL_STEP = 18;

export function boardDragScrollDelta(pointerX: number, left: number, right: number): number {
  if (pointerX < left + BOARD_DRAG_EDGE_SIZE) {
    const intensity = Math.min(1, (left + BOARD_DRAG_EDGE_SIZE - pointerX) / BOARD_DRAG_EDGE_SIZE);
    return -Math.ceil(BOARD_DRAG_MAX_SCROLL_STEP * intensity);
  }
  if (pointerX > right - BOARD_DRAG_EDGE_SIZE) {
    const intensity = Math.min(
      1,
      (pointerX - (right - BOARD_DRAG_EDGE_SIZE)) / BOARD_DRAG_EDGE_SIZE,
    );
    return Math.ceil(BOARD_DRAG_MAX_SCROLL_STEP * intensity);
  }
  return 0;
}

const MODE_LABELS: Record<IssueViewMode, string> = {
  list: "List",
  board: "Board",
  dependencies: "Dependencies",
};
type DependencyGraphLoadState = "idle" | "loading" | "ready" | "error";

let dependencyGraphPromise: Promise<typeof import("./DependencyGraphPanel")> | null = null;
let dependencyGraphReady = false;
export function loadDependencyGraphPanel() {
  if (!dependencyGraphPromise) {
    dependencyGraphPromise = import("./DependencyGraphPanel")
      .then((module) => {
        dependencyGraphReady = true;
        return module;
      })
      .catch((error) => {
        dependencyGraphPromise = null;
        dependencyGraphReady = false;
        throw error;
      });
  }
  return dependencyGraphPromise;
}

const DependencyGraphAttempts = createLazyAttempts(loadDependencyGraphPanel);

function preloadDependencyGraph() {
  void loadDependencyGraphPanel().catch(() => undefined);
}

function IssuesView({
  issues,
  linearWorkspace,
  stateOrder,
  loadWorkflowStates,
  onMoveIssue,
  loadBoardIssues,
  activeRunIssueIds,
  activeStates,
  initialMode = "dependencies",
  onModeChange,
  onOpenSettings,
}: {
  issues: IssueRow[];
  linearWorkspace: string | null;
  stateOrder?: string[];
  loadWorkflowStates?: () => Promise<WorkflowStateRow[]>;
  onMoveIssue?: (issueId: string, stateId: string) => Promise<void>;
  loadBoardIssues?: () => Promise<IssueRow[]>;
  activeRunIssueIds?: string[];
  activeStates?: string[];
  initialMode?: IssueViewMode;
  onModeChange?: (mode: IssueViewMode) => void;
  onOpenSettings: () => void;
}) {
  const [selectedMode, setSelectedMode] = useState<IssueViewMode>(initialMode);
  const [activeMode, setActiveMode] = useState<IssueViewMode>(initialMode);
  const [isModePending, startModeTransition] = useTransition();
  const [dependencyGraphLoadState, setDependencyGraphLoadState] =
    useState<DependencyGraphLoadState>(() => (dependencyGraphReady ? "ready" : "idle"));
  const [dependencyAttempt, setDependencyAttempt] = useState(() =>
    DependencyGraphAttempts.latest(),
  );
  const DependencyGraphPanel = DependencyGraphAttempts.get(dependencyAttempt);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependencyAttempt is an explicit retry signal.
  useEffect(() => {
    if (selectedMode !== "dependencies") return;
    if (dependencyGraphReady) {
      setDependencyGraphLoadState("ready");
      return;
    }

    let cancelled = false;
    setDependencyGraphLoadState("loading");
    void loadDependencyGraphPanel().then(
      () => {
        if (!cancelled) setDependencyGraphLoadState("ready");
      },
      () => {
        if (!cancelled) setDependencyGraphLoadState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dependencyAttempt, selectedMode]);

  const selectMode = (nextMode: IssueViewMode) => {
    if (nextMode === selectedMode) return;
    setSelectedMode(nextMode);
    onModeChange?.(nextMode);
    if (nextMode === "dependencies") {
      startModeTransition(() => setActiveMode(nextMode));
    } else {
      setActiveMode(nextMode);
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h2>Issues</h2>
          <p>
            {selectedMode === "board"
              ? "Every issue in the configured Linear scope. Drag cards when a single team is selected."
              : "The Linear issues Symphony is watching, refreshed on every poll."}
          </p>
        </div>
        <div className="issue-view-toggle" role="tablist" aria-label="Issue view">
          {(["list", "board", "dependencies"] as IssueViewMode[]).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={selectedMode === item}
              aria-controls="issues-panel"
              className={selectedMode === item ? "active" : undefined}
              onPointerEnter={item === "dependencies" ? preloadDependencyGraph : undefined}
              onFocus={item === "dependencies" ? preloadDependencyGraph : undefined}
              onClick={() => selectMode(item)}
            >
              {MODE_LABELS[item]}
            </button>
          ))}
        </div>
      </header>
      <section
        id="issues-panel"
        role="tabpanel"
        aria-busy={
          selectedMode === "dependencies" &&
          (isModePending ||
            activeMode !== "dependencies" ||
            dependencyGraphLoadState === "idle" ||
            dependencyGraphLoadState === "loading")
        }
      >
        <Panel
          title={
            selectedMode === "list"
              ? "Watched issues"
              : selectedMode === "board"
                ? "Board"
                : "Dependency graph"
          }
        >
          {selectedMode === "board" ? (
            <IssuesBoard
              issues={issues}
              linearWorkspace={linearWorkspace}
              stateOrder={stateOrder}
              loadWorkflowStates={loadWorkflowStates}
              onMoveIssue={onMoveIssue}
              loadBoardIssues={loadBoardIssues}
              activeRunIssueIds={activeRunIssueIds}
              activeStates={activeStates}
            />
          ) : issues.length === 0 ? (
            <Empty
              title="No issues yet"
              text="Once the worker connects to Linear, issues in your active states will appear here."
              actionLabel="Open settings"
              onAction={onOpenSettings}
            />
          ) : selectedMode === "dependencies" && activeMode !== "dependencies" ? (
            <DependencyGraphLoading />
          ) : selectedMode === "dependencies" && activeMode === "dependencies" ? (
            <ChunkErrorBoundary
              key={dependencyAttempt}
              view="Dependency graph"
              onRetry={() => {
                setDependencyGraphLoadState("loading");
                setDependencyAttempt(DependencyGraphAttempts.add());
              }}
            >
              <Suspense fallback={<DependencyGraphLoading />}>
                <DependencyGraphPanel issues={issues} />
              </Suspense>
            </ChunkErrorBoundary>
          ) : (
            <IssuesTable issues={issues} linearWorkspace={linearWorkspace} />
          )}
        </Panel>
      </section>
    </>
  );
}

function DependencyGraphLoading() {
  return (
    <div className="view-loading" aria-busy="true" aria-live="polite">
      <div className="view-loading-header">
        <span />
        <span />
      </div>
      <div className="view-loading-panels">
        <span />
        <span />
      </div>
      <span className="screen-reader-only">Preparing dependency graph…</span>
    </div>
  );
}

function IssuesTable({
  issues,
  linearWorkspace,
}: {
  issues: IssueRow[];
  linearWorkspace: string | null;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Issue</th>
          <th>State</th>
          <th>Priority</th>
          <th>Last seen</th>
          {linearWorkspace ? <th /> : null}
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => (
          <tr key={issue.id}>
            <td>
              <strong>{issue.identifier}</strong>
              <small>{issue.title}</small>
            </td>
            <td>
              <Badge status={issue.state} />
            </td>
            <td>{priorityLabel(issue.priority)}</td>
            <td className="tnum">
              <RelativeTime value={issue.last_seen_at} />
            </td>
            {linearWorkspace ? (
              <td className="row-actions">
                <button
                  type="button"
                  className="link-button"
                  aria-label={`Open ${issue.identifier} in Linear`}
                  onClick={() =>
                    openExternalUrl(
                      `https://linear.app/${linearWorkspace}/issue/${issue.identifier}`,
                    ).catch(() => undefined)
                  }
                >
                  Open in Linear ↗
                </button>
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function priorityRank(priority: number): number {
  // Linear priority: 0 = None, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low.
  // Sort urgent first and push "None" to the end.
  return priority === 0 ? Number.POSITIVE_INFINITY : priority;
}

function sortBoardIssues(issues: IssueRow[]): IssueRow[] {
  return [...issues].sort((a, b) => {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return a.identifier.localeCompare(b.identifier);
  });
}

function normalizeStateKey(state: string): string {
  return state.trim().toLowerCase();
}

function displayStateLabel(state: string): string {
  // Tracker states arrive lowercased; title-case them for a readable column label.
  return state.trim().replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

export type BoardColumn = {
  // Linear workflow state id; null for fallback/derived lanes (not drop targets).
  id: string | null;
  // Linear state category (backlog|unstarted|started|completed|...); null for fallback lanes.
  type: string | null;
  key: string;
  label: string;
  issues: IssueRow[];
};

// Board ordering follows Linear: by state category first, then position within it.
const STATE_TYPE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

function stateTypeRank(type: string): number {
  return STATE_TYPE_ORDER[type] ?? 3.5;
}

export function boardColumns(
  issues: IssueRow[],
  options: {
    workflowStates?: WorkflowStateRow[] | null;
    stateOrder?: string[];
    overrides?: Map<string, { target: string; from: string }>;
  },
): BoardColumn[] {
  const overrides = options.overrides ?? new Map<string, { target: string; from: string }>();
  const effectiveKey = (issue: IssueRow) =>
    overrides.get(issue.id)?.target ?? normalizeStateKey(issue.state);

  const groups = new Map<string, IssueRow[]>();
  for (const issue of issues) {
    const key = effectiveKey(issue);
    const bucket = groups.get(key);
    if (bucket) bucket.push(issue);
    else groups.set(key, [issue]);
  }

  const columns: BoardColumn[] = [];
  const seen = new Set<string>();
  const pushColumn = (key: string, label: string, id: string | null, type: string | null) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    columns.push({ id, type, key, label, issues: sortBoardIssues(groups.get(key) ?? []) });
  };

  const states = options.workflowStates ?? null;
  if (states && states.length > 0) {
    // Lanes come from the team's Linear workflow, ordered by category then position
    // (matches Linear: e.g. "In Review" sits with the other started states).
    const ordered = [...states].sort((a, b) => {
      const byType = stateTypeRank(a.state_type) - stateTypeRank(b.state_type);
      return byType !== 0 ? byType : a.position - b.position;
    });
    for (const state of ordered) {
      pushColumn(normalizeStateKey(state.name), state.name.trim(), state.id, state.state_type);
    }
  } else {
    // Fallback (preview/tests or missing team): configured states drive the lanes.
    for (const state of options.stateOrder ?? []) {
      pushColumn(normalizeStateKey(state), state.trim(), null, null);
    }
  }

  // Surface any state present on an issue that no lane covers yet.
  for (const issue of issues) {
    const key = effectiveKey(issue);
    if (!seen.has(key)) pushColumn(key, displayStateLabel(issue.state), null, null);
  }

  return columns;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unexpected error";
}

// Only compare pointer ids when both are known (jsdom omits them in tests).
function samePointer(a: number | null | undefined, b: number | null | undefined): boolean {
  return a == null || b == null || a === b;
}

// How often the board re-polls Linear for issue movement while it is open.
export const BOARD_REFRESH_INTERVAL_MS = 15_000;
// Bound mounted card trees while keeping every workflow lane visible.
export const BOARD_COLUMN_PAGE_SIZE = 50;

function IssuesBoard({
  issues,
  linearWorkspace,
  stateOrder,
  loadWorkflowStates,
  loadBoardIssues,
  activeRunIssueIds,
  activeStates,
  onMoveIssue,
}: {
  issues: IssueRow[];
  linearWorkspace: string | null;
  stateOrder?: string[];
  loadWorkflowStates?: () => Promise<WorkflowStateRow[]>;
  loadBoardIssues?: () => Promise<IssueRow[]>;
  activeRunIssueIds?: string[];
  activeStates?: string[];
  onMoveIssue?: (issueId: string, stateId: string) => Promise<void>;
}) {
  const [workflowStates, setWorkflowStates] = useState<WorkflowStateRow[] | null>(null);
  const [boardIssues, setBoardIssues] = useState<IssueRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [overrides, setOverrides] = useState<Map<string, { target: string; from: string }>>(
    () => new Map(),
  );
  const [movingIds, setMovingIds] = useState<Set<string>>(() => new Set());
  const [dragKey, setDragKey] = useState<string | null>(null);
  // Pointer-based drag: WKWebView does not deliver HTML5 drop events to targets.
  const dragRef = useRef<{
    issueId: string;
    identifier: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    hoverKey: string | null;
  } | null>(null);
  // The drag ghost is positioned imperatively to avoid a re-render on every move.
  const [draggingLabel, setDraggingLabel] = useState<string | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const boardBodyRef = useRef<HTMLDivElement | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  // Guard against out-of-order responses and post-unmount state updates.
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  // Coalesce fetches: the 15s interval can be shorter than a retrying request.
  const inFlightRef = useRef(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [visibleIssueCounts, setVisibleIssueCounts] = useState<Map<string, number>>(
    () => new Map(),
  );

  useEffect(() => {
    // Set on mount too: StrictMode's simulated unmount/remount would otherwise
    // leave this false forever, making every board response get ignored.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch workflow states once when the board mounts. The backend returns
  // state-aware lanes only when exactly one Linear team is configured.
  useEffect(() => {
    if (!loadWorkflowStates) return;
    let cancelled = false;
    setLoading(true);
    loadWorkflowStates()
      .then((states) => {
        if (!cancelled) setWorkflowStates(states);
      })
      .catch(() => {
        // Leave workflowStates null so the board falls back to configured lanes.
        if (!cancelled) setWorkflowStates(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadWorkflowStates]);

  // Live board issues span every state, including unwatched ones like In Review.
  const refreshBoardIssues = useCallback(() => {
    if (!loadBoardIssues) return;
    // Don't reshuffle lanes out from under an in-flight drag, and never stack
    // concurrent board fetches (which would swallow errors and add Linear load).
    if (dragRef.current || inFlightRef.current) return;
    const seq = ++requestSeqRef.current;
    inFlightRef.current = true;
    setRefreshing(true);
    loadBoardIssues()
      .then((rows) => {
        // Ignore stale/out-of-order responses and post-unmount resolution.
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        setBoardIssues(rows);
        setLastUpdated(new Date().toISOString());
        markRelativeTimeNow();
        setBoardError(null);
      })
      .catch((error) => {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        setBoardError(errorText(error));
      })
      .finally(() => {
        inFlightRef.current = false;
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        setRefreshing(false);
      });
  }, [loadBoardIssues]);

  // Poll board issues so lanes stay fresh, surfaced via the "Updated" stamp.
  // Pause while the window is hidden to avoid needless Linear traffic.
  useEffect(() => {
    if (!loadBoardIssues) return;
    refreshBoardIssues();
    const tick = () => {
      if (document.visibilityState === "visible") refreshBoardIssues();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshBoardIssues();
    };
    const id = window.setInterval(tick, BOARD_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadBoardIssues, refreshBoardIssues]);

  // A successful but empty board fetch (unscoped/capped) must not hide the watched
  // issues, which are a subset of the board; only use the board when it has rows.
  const effectiveIssues = boardIssues && boardIssues.length > 0 ? boardIssues : issues;

  // Drop optimistic overrides once fetched issue data reflects the new state.
  useEffect(() => {
    setOverrides((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const issue of effectiveIssues) {
        const override = next.get(issue.id);
        // Clear once Linear reports a state other than the pre-move one — the move
        // took effect, or the issue advanced further (e.g. an agent moved it on).
        if (override !== undefined && normalizeStateKey(issue.state) !== override.from) {
          next.delete(issue.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [effectiveIssues]);

  const columns = useMemo(
    () => boardColumns(effectiveIssues, { workflowStates, stateOrder, overrides }),
    [effectiveIssues, workflowStates, stateOrder, overrides],
  );

  const dragEnabled = Boolean(onMoveIssue) && (workflowStates?.length ?? 0) > 0;
  const activeRunSet = useMemo(() => new Set(activeRunIssueIds ?? []), [activeRunIssueIds]);
  const watchedKeys = useMemo(
    () => new Set((activeStates ?? []).map(normalizeStateKey)),
    [activeStates],
  );
  const [pendingMove, setPendingMove] = useState<{
    issue: IssueRow;
    column: BoardColumn;
    entering: boolean;
  } | null>(null);

  const moveIssue = useCallback(
    (issue: IssueRow, column: BoardColumn) => {
      if (!onMoveIssue || !column.id) return;
      if (activeRunSet.has(issue.id)) {
        setMoveError(
          `Can't move ${issue.identifier} while an agent run is active — stop the run first.`,
        );
        return;
      }
      const currentKey = overrides.get(issue.id)?.target ?? normalizeStateKey(issue.state);
      if (currentKey === column.key) return;
      const stateId = column.id;
      setMoveError(null);
      setOverrides((prev) => new Map(prev).set(issue.id, { target: column.key, from: currentKey }));
      setMovingIds((prev) => new Set(prev).add(issue.id));
      onMoveIssue(issue.id, stateId)
        .then(() => {
          // Re-pull so the lane reflects the authoritative Linear state.
          refreshBoardIssues();
        })
        .catch((error) => {
          // Roll the card back to its original lane and surface the failure.
          setOverrides((prev) => {
            const next = new Map(prev);
            next.delete(issue.id);
            return next;
          });
          setMoveError(`Couldn't move ${issue.identifier}: ${errorText(error)}`);
        })
        .finally(() => {
          setMovingIds((prev) => {
            const next = new Set(prev);
            next.delete(issue.id);
            return next;
          });
        });
    },
    [activeRunSet, onMoveIssue, overrides, refreshBoardIssues],
  );

  // Gate a move behind a confirm when it crosses Symphony's watched (dispatch)
  // boundary — moving into a watched state enqueues an agent; moving out drops it.
  const requestMove = useCallback(
    (issue: IssueRow, column: BoardColumn) => {
      if (!onMoveIssue || !column.id) return;
      const currentKey = overrides.get(issue.id)?.target ?? normalizeStateKey(issue.state);
      if (currentKey === column.key) return;
      const fromWatched = watchedKeys.has(currentKey);
      const toWatched = watchedKeys.has(column.key);
      if (fromWatched !== toWatched) {
        setPendingMove({ issue, column, entering: toWatched });
        return;
      }
      moveIssue(issue, column);
    },
    [moveIssue, onMoveIssue, overrides, watchedKeys],
  );

  const setHoveredColumnKey = useCallback((key: string | null) => {
    const drag = dragRef.current;
    if (drag === null || !drag.active || drag.hoverKey === key) return;
    drag.hoverKey = key;
    setDragKey(key);
  }, []);

  const updateHoveredColumnAtPoint = useCallback(
    (x: number, y: number) => {
      if (typeof document.elementFromPoint !== "function") return;
      const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-board-drop-key]");
      setHoveredColumnKey(target?.dataset.boardDropKey ?? null);
    },
    [setHoveredColumnKey],
  );

  // Global pointer listeners keep the drag alive as the cursor leaves the card.
  useEffect(() => {
    if (!dragEnabled) return;
    let autoScrollFrame: number | null = null;
    let pointerPosition = { x: 0, y: 0 };

    const stopAutoScroll = () => {
      if (autoScrollFrame === null) return;
      window.cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = null;
    };
    const autoScroll = () => {
      autoScrollFrame = null;
      const drag = dragRef.current;
      const body = boardBodyRef.current;
      if (!drag?.active || !body) return;

      const bounds = body.getBoundingClientRect();
      const pointerInsideBoard =
        pointerPosition.y >= bounds.top && pointerPosition.y <= bounds.bottom;
      const delta = pointerInsideBoard
        ? boardDragScrollDelta(pointerPosition.x, bounds.left, bounds.right)
        : 0;
      const maxScrollLeft = Math.max(0, body.scrollWidth - body.clientWidth);
      const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, body.scrollLeft + delta));
      if (delta === 0 || nextScrollLeft === body.scrollLeft) return;

      body.scrollLeft = nextScrollLeft;
      // Scrolling moves lanes underneath a stationary pointer, so refresh the
      // drop target even when the browser does not emit another pointermove.
      updateHoveredColumnAtPoint(pointerPosition.x, pointerPosition.y);
      autoScrollFrame = window.requestAnimationFrame(autoScroll);
    };
    const startAutoScroll = () => {
      if (autoScrollFrame === null) {
        autoScrollFrame = window.requestAnimationFrame(autoScroll);
      }
    };
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !samePointer(drag.pointerId, event.pointerId)) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
        drag.active = true;
        setDraggingLabel(drag.identifier);
      }
      event.preventDefault();
      pointerPosition = { x: event.clientX, y: event.clientY };
      ghostPosRef.current = { x: event.clientX, y: event.clientY };
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.style.left = `${Number.isFinite(event.clientX) ? event.clientX + 12 : 0}px`;
        ghost.style.top = `${Number.isFinite(event.clientY) ? event.clientY + 12 : 0}px`;
      }
      startAutoScroll();
    };
    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !samePointer(drag.pointerId, event.pointerId)) return;
      stopAutoScroll();
      dragRef.current = null;
      const { active, hoverKey, issueId } = drag;
      setDraggingLabel(null);
      setDragKey(null);
      if (active && hoverKey) {
        const column = columns.find((entry) => entry.key === hoverKey && entry.id !== null);
        const issue = effectiveIssues.find((entry) => entry.id === issueId);
        if (column && issue) requestMove(issue, column);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopAutoScroll();
    };
  }, [dragEnabled, columns, effectiveIssues, requestMove, updateHoveredColumnAtPoint]);

  const startDrag = useCallback(
    (event: React.PointerEvent, issue: IssueRow) => {
      // event.button > 0 rejects right/middle click; undefined (jsdom) passes.
      if (!dragEnabled || event.button > 0) return;
      // Let clicks on the Open link through instead of starting a drag.
      if ((event.target as HTMLElement).closest("button, a")) return;
      // Release implicit pointer capture (touch/pen) so lanes still receive
      // pointer events for hover detection during the drag.
      const target = event.target as Element;
      if (target.hasPointerCapture?.(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      dragRef.current = {
        issueId: issue.id,
        identifier: issue.identifier,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        hoverKey: null,
      };
    },
    [dragEnabled],
  );

  const hoverColumn = useCallback(
    (column: BoardColumn) => {
      if (column.id !== null) setHoveredColumnKey(column.key);
    },
    [setHoveredColumnKey],
  );

  const leaveColumn = useCallback((column: BoardColumn) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.hoverKey === column.key) {
      drag.hoverKey = null;
      setDragKey((current) => (current === column.key ? null : current));
    }
  }, []);

  const renderColumn = (column: BoardColumn) => {
    const droppable = dragEnabled && column.id !== null;
    const watched = watchedKeys.has(column.key);
    const visibleIssueCount = visibleIssueCounts.get(column.key) ?? BOARD_COLUMN_PAGE_SIZE;
    const visibleIssues = column.issues.slice(0, visibleIssueCount);
    const remainingIssueCount = column.issues.length - visibleIssues.length;
    return (
      <section
        key={column.key}
        data-board-column={column.key}
        data-board-drop-key={droppable ? column.key : undefined}
        className={`issue-board-column${dragKey === column.key ? " drag-over" : ""}`}
        aria-label={`${column.label} (${column.issues.length})`}
        onPointerMove={droppable ? () => hoverColumn(column) : undefined}
        onPointerLeave={droppable ? () => leaveColumn(column) : undefined}
      >
        <header className="issue-board-column-header">
          <span className="issue-board-column-title">
            <Badge status={column.label} />
            {watched ? (
              <span
                className="issue-board-watched"
                role="img"
                aria-label="Watched by Symphony"
                title="Watched by Symphony"
              >
                🤖
              </span>
            ) : null}
          </span>
          <span className="issue-board-count tnum">{column.issues.length}</span>
        </header>
        <div className="issue-board-cards">
          {column.issues.length === 0 ? (
            <p className="issue-board-empty">No issues</p>
          ) : (
            visibleIssues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                linearWorkspace={linearWorkspace}
                // Locked until the move reconciles (override cleared), so a second
                // move can't race a stale poll and revert the card to an older lane.
                draggable={dragEnabled && !movingIds.has(issue.id) && !overrides.has(issue.id)}
                moving={movingIds.has(issue.id)}
                onPointerDown={(event) => startDrag(event, issue)}
              />
            ))
          )}
          {remainingIssueCount > 0 ? (
            <button
              type="button"
              className="issue-board-more"
              aria-label={`Show more issues in ${column.label}`}
              onClick={() =>
                setVisibleIssueCounts((current) =>
                  new Map(current).set(
                    column.key,
                    (current.get(column.key) ?? BOARD_COLUMN_PAGE_SIZE) + BOARD_COLUMN_PAGE_SIZE,
                  ),
                )
              }
            >
              Show {Math.min(BOARD_COLUMN_PAGE_SIZE, remainingIssueCount)} more issues
            </button>
          ) : null}
        </div>
      </section>
    );
  };

  return (
    <div
      className="issue-board"
      aria-busy={
        loading || (Boolean(loadBoardIssues) && boardIssues === null && !boardError) || undefined
      }
    >
      {loadBoardIssues ? (
        <div className="issue-board-toolbar">
          <span className="issue-board-updated">
            {boardError && !lastUpdated ? (
              <span className="issue-board-updated-error" title={boardError}>
                Couldn't load board
              </span>
            ) : lastUpdated ? (
              <>
                Updated <RelativeTime value={lastUpdated} />
              </>
            ) : (
              "Loading…"
            )}
          </span>
          <button
            type="button"
            className="issue-board-refresh"
            onClick={refreshBoardIssues}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      ) : null}
      {moveError ? (
        <p className="issue-board-error" role="alert">
          {moveError}
        </p>
      ) : null}
      {pendingMove ? (
        <div className="issue-board-confirm" role="alertdialog" aria-label="Confirm status change">
          <span>
            {pendingMove.entering
              ? `Move ${pendingMove.issue.identifier} to ${pendingMove.column.label}? Symphony will dispatch an agent on the next poll.`
              : `Move ${pendingMove.issue.identifier} to ${pendingMove.column.label}? Symphony will stop working it (any active run keeps going).`}
          </span>
          <div className="issue-board-confirm-actions">
            <button
              type="button"
              onClick={() => {
                moveIssue(pendingMove.issue, pendingMove.column);
                setPendingMove(null);
              }}
            >
              Move
            </button>
            <button type="button" onClick={() => setPendingMove(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div ref={boardBodyRef} className="issue-board-body">
        <div className="issue-board-columns">{columns.map(renderColumn)}</div>
      </div>
      {draggingLabel ? (
        <div
          ref={ghostRef}
          className="issue-drag-ghost"
          style={{
            left: Number.isFinite(ghostPosRef.current.x) ? ghostPosRef.current.x + 12 : 0,
            top: Number.isFinite(ghostPosRef.current.y) ? ghostPosRef.current.y + 12 : 0,
          }}
        >
          {draggingLabel}
        </div>
      ) : null}
    </div>
  );
}

function IssueCard({
  issue,
  linearWorkspace,
  draggable = false,
  moving = false,
  onPointerDown,
}: {
  issue: IssueRow;
  linearWorkspace: string | null;
  draggable?: boolean;
  moving?: boolean;
  onPointerDown?: (event: React.PointerEvent) => void;
}) {
  const openInLinear = linearWorkspace
    ? () =>
        openExternalUrl(`https://linear.app/${linearWorkspace}/issue/${issue.identifier}`).catch(
          () => undefined,
        )
    : undefined;
  return (
    <article
      className={`issue-card${draggable ? " draggable" : ""}${moving ? " moving" : ""}`}
      onPointerDown={draggable ? onPointerDown : undefined}
    >
      <div className="issue-card-top">
        <strong>{issue.identifier}</strong>
        <span className={`issue-card-priority priority-${issue.priority}`}>
          {priorityLabel(issue.priority)}
        </span>
      </div>
      <p className="issue-card-title">{issue.title}</p>
      <div className="issue-card-foot">
        <RelativeTime value={issue.last_seen_at} />
        {moving ? <span className="issue-card-moving">Moving…</span> : null}
        {openInLinear ? (
          <button
            type="button"
            className="link-button"
            aria-label={`Open ${issue.identifier} in Linear`}
            onClick={openInLinear}
          >
            Open ↗
          </button>
        ) : null}
      </div>
    </article>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Empty({
  title,
  text,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  title: string;
  text?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {text ? <span>{text}</span> : null}
      {actionLabel ? (
        <button type="button" disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function Badge({ status }: { status: string }) {
  return <span className={`badge ${statusSlug(status)}`}>{status}</span>;
}

export default IssuesView;
