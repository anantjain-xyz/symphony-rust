import { useEffect, useMemo, useState } from "react";
import type { RunDetail, RunWithIssueRow } from "../bindings";
import { formatTokens, parseSessionInfo, shortTime } from "../format";
import { Badge, Empty, Panel, RunTable } from "../viewPrimitives";
import { EventStream } from "./EventStream";
import "./RunsView.css";

function SessionChips({ raw }: { raw: string | null }) {
  const info = parseSessionInfo(raw);
  if (!info) return null;
  const chips: { label: string; title: string; mono?: boolean }[] = [];
  if (info.model) {
    chips.push({ label: info.model, title: "Model", mono: true });
  }
  if (info.permission_mode) {
    chips.push({ label: info.permission_mode, title: "Permission mode" });
  }
  if (info.fast_mode === "on") {
    chips.push({ label: "fast mode", title: "Fast mode enabled" });
  }
  if (info.output_style && info.output_style !== "default") {
    chips.push({ label: `${info.output_style} style`, title: "Output style" });
  }
  if (info.thinking_tokens) {
    chips.push({
      label: `${formatTokens(info.thinking_tokens)} thinking`,
      title: "Estimated thinking tokens",
    });
  }
  if (info.agent_version) {
    chips.push({ label: `Claude Code ${info.agent_version}`, title: "Agent version" });
  }
  if (chips.length === 0) return null;
  return (
    <div className="run-meta-row session-chips">
      {chips.map((chip) => (
        <span
          key={chip.title}
          className={chip.mono ? "session-chip mono" : "session-chip"}
          title={chip.title}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}

function RunsView({
  runs,
  selected,
  activeRunIds,
  multiRepo,
  onOpenRun,
  onStopRun,
  canTriggerRetry,
  onTriggerRetryNow,
  triggeringRetryIds,
  stoppingRunIds,
}: {
  runs: RunWithIssueRow[];
  selected: RunDetail | null;
  activeRunIds: Set<string>;
  multiRepo: boolean;
  onOpenRun: (id: string) => void;
  onStopRun: (id: string) => void;
  canTriggerRetry: boolean;
  onTriggerRetryNow: (issueId: string) => void;
  triggeringRetryIds: Set<string>;
  stoppingRunIds: Set<string>;
}) {
  const [repoFilter, setRepoFilter] = useState("");
  // Repos that actually appear in the loaded history; a filter for a repo
  // with no runs would only ever show an empty table.
  const repoOptions = useMemo(
    () =>
      Array.from(
        new Set(runs.map((run) => run.repo_name).filter((name): name is string => !!name)),
      ).sort(),
    [runs],
  );
  useEffect(() => {
    if (repoFilter !== "" && !repoOptions.includes(repoFilter)) setRepoFilter("");
  }, [repoFilter, repoOptions]);
  const visibleRuns = repoFilter === "" ? runs : runs.filter((run) => run.repo_name === repoFilter);
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Runs</h2>
          <p>Dispatch history and live agent event stream.</p>
        </div>
        {multiRepo && repoOptions.length > 0 ? (
          <div className="actions">
            <select
              className="repo-filter-select"
              aria-label="Filter runs by repository"
              value={repoFilter}
              onChange={(event) => setRepoFilter(event.currentTarget.value)}
            >
              <option value="">All repos</option>
              {repoOptions.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>
      <div className="split">
        <Panel title="Run history">
          <div className="panel-scroll">
            <RunTable
              runs={visibleRuns}
              onOpenRun={onOpenRun}
              emptyTitle={repoFilter === "" ? "No runs yet" : "No runs for this repo"}
              emptyText={
                repoFilter === ""
                  ? "Runs will appear after the worker dispatches the first issue."
                  : `No loaded runs were dispatched to ${repoFilter}.`
              }
              activeRunIds={activeRunIds}
              selectedRunId={selected?.run.id}
              showRepo={multiRepo}
            />
          </div>
        </Panel>
        <Panel
          title={
            selected
              ? `${selected.run.issue_identifier} · Run #${selected.run.run_number}`
              : "Event stream"
          }
        >
          {!selected ? (
            <Empty
              title="Select a run"
              text="Choose a run from the history table to inspect its event stream."
            />
          ) : (
            <>
              <div className="run-meta">
                <div className="run-meta-head">
                  <div className="run-meta-row">
                    <Badge status={selected.run.status} />
                    {selected.run.repo_name ? (
                      <span className="repo-badge">{selected.run.repo_name}</span>
                    ) : null}
                    <span>{selected.run.issue_title}</span>
                  </div>
                  <div className="run-meta-actions">
                    {selected.run.status === "cancelled" ? (
                      <button
                        type="button"
                        className="link-button outlined"
                        disabled={!canTriggerRetry || triggeringRetryIds.has(selected.run.issue_id)}
                        title={
                          canTriggerRetry
                            ? "Dispatch this issue again"
                            : "Start the worker to retry this run"
                        }
                        onClick={() => onTriggerRetryNow(selected.run.issue_id)}
                      >
                        {triggeringRetryIds.has(selected.run.issue_id)
                          ? "Retrying..."
                          : "Retry run"}
                      </button>
                    ) : null}
                    {selected.run.status === "pending" || selected.run.status === "running" ? (
                      <button
                        type="button"
                        className="link-button danger outlined"
                        disabled={stoppingRunIds.has(selected.run.id)}
                        onClick={() => onStopRun(selected.run.id)}
                      >
                        {stoppingRunIds.has(selected.run.id) ? "Stopping..." : "Stop run"}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="run-meta-row muted">
                  <span>Created {shortTime(selected.run.created_at)}</span>
                  {selected.run.ended_at ? (
                    <span>Ended {shortTime(selected.run.ended_at)}</span>
                  ) : null}
                </div>
                <SessionChips raw={selected.run.session_info} />
                <code className="run-meta-path" title={selected.run.workspace_path}>
                  {selected.run.workspace_path}
                </code>
                {selected.run.error_message ? (
                  <div className="run-error">
                    <strong>{selected.run.error_class ?? "Error"}</strong>
                    <span>{selected.run.error_message}</span>
                  </div>
                ) : null}
              </div>
              <EventStream events={selected.events} live={selected.run.status === "running"} />
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

export default RunsView;
