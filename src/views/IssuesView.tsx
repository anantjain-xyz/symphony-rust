import { Suspense, useEffect, useState, useTransition } from "react";
import type { IssueRow } from "../bindings";
import { ChunkErrorBoundary, createLazyAttempts } from "../ChunkBoundary";
import { openExternalUrl } from "../desktop/shell";
import { priorityLabel, statusSlug } from "../format";
import { RelativeTime } from "../RelativeTime";
import "./IssuesView.css";

type IssueViewMode = "list" | "dependencies";
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
  onOpenSettings,
}: {
  issues: IssueRow[];
  linearWorkspace: string | null;
  onOpenSettings: () => void;
}) {
  const [selectedMode, setSelectedMode] = useState<IssueViewMode>("list");
  const [activeMode, setActiveMode] = useState<IssueViewMode>("list");
  const [isModePending, startModeTransition] = useTransition();
  const [dependencyGraphLoadState, setDependencyGraphLoadState] = useState<
    DependencyGraphLoadState
  >(
    () => (dependencyGraphReady ? "ready" : "idle"),
  );
  const [dependencyAttempt, setDependencyAttempt] = useState(() =>
    DependencyGraphAttempts.latest(),
  );
  const DependencyGraphPanel = DependencyGraphAttempts.get(dependencyAttempt);

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
          <p>The Linear issues Symphony is watching, refreshed on every poll.</p>
        </div>
        <div className="issue-view-toggle" role="tablist" aria-label="Issue view">
          {(["list", "dependencies"] as IssueViewMode[]).map((item) => (
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
              {item === "list" ? "List" : "Dependencies"}
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
        <Panel title={selectedMode === "list" ? "Watched issues" : "Dependency graph"}>
          {issues.length === 0 ? (
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
        <button disabled={actionDisabled} onClick={onAction}>
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
