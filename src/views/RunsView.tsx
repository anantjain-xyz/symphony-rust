import { useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunWithIssueRow } from "../bindings";
import { formatTokens, parseSessionInfo, shortTime } from "../format";
import { Badge, Empty, Panel, RunTable } from "../viewPrimitives";
import { EventStream } from "./EventStream";
import "./IconSelect.css";
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
            <RepoFilterSelect value={repoFilter} repos={repoOptions} onChange={setRepoFilter} />
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

function RepoFilterSelect({
  value,
  repos,
  onChange,
}: {
  value: string;
  repos: string[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const options = useMemo(
    () => [
      { value: "", label: "All repos" },
      ...repos.map((repo) => ({ value: repo, label: repo })),
    ],
    [repos],
  );
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, options.length - 1));
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function openList() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="icon-select repo-filter-select" ref={rootRef}>
      <button
        type="button"
        className="icon-select-trigger repo-filter-trigger"
        role="combobox"
        aria-label="Filter runs by repository"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? "repo-filter-listbox" : undefined}
        aria-activedescendant={open ? `repo-filter-option-${activeIndex}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleKeyDown}
      >
        <span className="repo-filter-label">{selected.label}</span>
        <svg className="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div className="icon-select-list repo-filter-list" id="repo-filter-listbox" role="listbox">
          {options.map((option, index) => (
            <div
              key={option.value || "all"}
              id={`repo-filter-option-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              className={index === activeIndex ? "icon-select-option active" : "icon-select-option"}
              title={option.label}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => commit(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  commit(index);
                }
              }}
            >
              <span className="icon-select-check" aria-hidden="true">
                {option.value === value ? (
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      d="M3 8.5l3.5 3.5L13 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </span>
              <span className="repo-filter-option-label">{option.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default RunsView;
