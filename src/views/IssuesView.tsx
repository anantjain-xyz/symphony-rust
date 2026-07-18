import { openUrl } from "@tauri-apps/plugin-opener";
import { Suspense, useState } from "react";
import type { IssueRow } from "../bindings";
import {
  ChunkErrorBoundary,
  ViewLoading,
  createLazyAttempts,
} from "../ChunkBoundary";
import { priorityLabel, statusSlug } from "../format";
import { RelativeTime } from "../RelativeTime";
import "./IssuesView.css";

type IssueViewMode = "list" | "dependencies";

let dependencyGraphPromise: Promise<typeof import("./DependencyGraphView")> | null = null;
export function loadDependencyGraphView() {
  if (!dependencyGraphPromise) {
    dependencyGraphPromise = import("./DependencyGraphView").catch((error) => {
      dependencyGraphPromise = null;
      throw error;
    });
  }
  return dependencyGraphPromise;
}

const DependencyGraphAttempts = createLazyAttempts(loadDependencyGraphView);

function preloadDependencyGraph() {
  void loadDependencyGraphView().catch(() => undefined);
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
  const [mode, setMode] = useState<IssueViewMode>("list");
  const [dependencyAttempt, setDependencyAttempt] = useState(() =>
    DependencyGraphAttempts.latest(),
  );
  const DependencyGraph = DependencyGraphAttempts.get(dependencyAttempt);

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
              aria-selected={mode === item}
              aria-controls="issues-panel"
              className={mode === item ? "active" : undefined}
              onPointerEnter={item === "dependencies" ? preloadDependencyGraph : undefined}
              onFocus={item === "dependencies" ? preloadDependencyGraph : undefined}
              onClick={() => setMode(item)}
            >
              {item === "list" ? "List" : "Dependencies"}
            </button>
          ))}
        </div>
      </header>
      <section id="issues-panel" role="tabpanel">
        <Panel title={mode === "list" ? "Watched issues" : "Dependency graph"}>
          {issues.length === 0 ? (
            <Empty
              title="No issues yet"
              text="Once the worker connects to Linear, issues in your active states will appear here."
              actionLabel="Open settings"
              onAction={onOpenSettings}
            />
          ) : mode === "dependencies" ? (
            <ChunkErrorBoundary
              key={dependencyAttempt}
              view="Dependency graph"
              onRetry={() => setDependencyAttempt(DependencyGraphAttempts.add())}
            >
              <Suspense fallback={<ViewLoading view="dependency graph" />}>
                <DependencyGraph issues={issues} />
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
                    openUrl(
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
