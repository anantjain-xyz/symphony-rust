import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEventRow, RunDetail, RunWithIssueRow } from "../bindings";
import {
  describeEvent,
  formatTokens,
  parseSessionInfo,
  prettyPayload,
  shortTime,
  statusSlug,
} from "../format";
import {
  MarkdownText,
  countMarkdownMatches,
  countMatches,
  highlightMatches,
} from "../MarkdownText";
import { AbsoluteTime, RelativeTime } from "../RelativeTime";
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
  const visibleRuns =
    repoFilter === "" ? runs : runs.filter((run) => run.repo_name === repoFilter);
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Runs</h2>
          <p>Dispatch history and live agent event stream.</p>
        </div>
        {multiRepo && repoOptions.length > 0 ? (
          <div className="actions">
            <RepoFilterSelect
              value={repoFilter}
              repos={repoOptions}
              onChange={setRepoFilter}
            />
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
                        disabled={
                          !canTriggerRetry || triggeringRetryIds.has(selected.run.issue_id)
                        }
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
                <code
                  className="run-meta-path"
                  title={selected.run.workspace_path}
                >
                  {selected.run.workspace_path}
                </code>
                {selected.run.error_message ? (
                  <div className="run-error">
                    <strong>{selected.run.error_class ?? "Error"}</strong>
                    <span>{selected.run.error_message}</span>
                  </div>
                ) : null}
              </div>
              <EventStream
                events={selected.events}
                live={selected.run.status === "running"}
              />
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
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
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
        <ul className="icon-select-list repo-filter-list" id="repo-filter-listbox" role="listbox">
          {options.map((option, index) => (
            <li
              key={option.value || "all"}
              id={`repo-filter-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              className={
                index === activeIndex ? "icon-select-option active" : "icon-select-option"
              }
              title={option.label}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              <span className="icon-select-check" aria-hidden="true">
                {option.value === value ? (
                  <svg viewBox="0 0 16 16" width="12" height="12">
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
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function scrollToMatch(container: HTMLElement | null, index: number) {
  const mark = container?.querySelector(`mark[data-match-index="${index}"]`);
  if (!(mark instanceof HTMLElement)) return;
  // A match inside a collapsed payload is invisible until its details opens.
  const details = mark.closest("details");
  if (details && !details.open) details.open = true;
  mark.scrollIntoView({ block: "center", inline: "nearest" });
}

function EventStream({
  events,
  live,
}: {
  events: AgentEventRow[];
  live: boolean;
}) {
  // The worker writes a "humanized" twin alongside every raw event that has
  // a summary; the summaries below cover the raw events, so skip the twins.
  const visible = useMemo(
    () => events.filter((event) => event.kind !== "humanized"),
    [events],
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastScrolledMatch = useRef("");
  const [follow, setFollow] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);

  const described = useMemo(
    () =>
      visible.map((event) => ({
        ...describeEvent(event.kind, event.payload),
        pretty: prettyPayload(event.payload),
      })),
    [visible],
  );

  const needle = searchOpen ? query.toLowerCase() : "";

  // Number every match across events so Enter/Shift+Enter can walk them in
  // document order; each event records where its label/summary/payload start.
  const { matchStarts, totalMatches } = useMemo(() => {
    const matchStarts: { label: number; summary: number; payload: number }[] = [];
    let totalMatches = 0;
    for (const item of described) {
      const label = totalMatches;
      totalMatches += countMatches(item.label, needle);
      const summary = totalMatches;
      totalMatches += countMarkdownMatches(item.summary, needle);
      const payload = totalMatches;
      totalMatches += countMatches(item.pretty, needle);
      matchStarts.push({ label, summary, payload });
    }
    return { matchStarts, totalMatches };
  }, [described, needle]);

  useEffect(() => {
    setCurrent(0);
  }, [needle]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchOpen]);

  useEffect(() => {
    if (current !== 0 && current >= totalMatches) setCurrent(0);
  }, [current, totalMatches]);

  useEffect(() => {
    if (!follow) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow]);

  // Keep the active match in view. Runs after every render but only acts when
  // the (query, index) pair changed, so live events streaming in while the
  // user reads a match don't re-yank the scroll position.
  useEffect(() => {
    if (!needle || totalMatches === 0) {
      lastScrolledMatch.current = "";
      return;
    }
    const key = `${needle}\u0000${current}`;
    if (lastScrolledMatch.current === key) return;
    lastScrolledMatch.current = key;
    scrollToMatch(containerRef.current, current);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const findShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f";
      if (findShortcut && visible.length > 0) {
        event.preventDefault();
        if (searchOpen) {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else {
          setSearchOpen(true);
        }
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, visible.length]);

  const step = (dir: 1 | -1) => {
    if (totalMatches === 0) return;
    if (totalMatches === 1) {
      // The index can't change, so re-center the only match directly.
      scrollToMatch(containerRef.current, 0);
      return;
    }
    setCurrent((prev) => (prev + dir + totalMatches) % totalMatches);
  };

  if (visible.length === 0) {
    return (
      <Empty title="No events recorded" text="This run has no agent events yet." />
    );
  }

  return (
    <div className="events-wrap">
      {searchOpen ? (
        <div className="event-search">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            placeholder="Search events…"
            aria-label="Search run log"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {needle ? (
            <span className="event-search-count tnum">
              {totalMatches === 0
                ? "0/0"
                : `${Math.min(current + 1, totalMatches)}/${totalMatches}`}
            </span>
          ) : null}
          <button
            type="button"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            disabled={totalMatches === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            title="Next match (Enter)"
            aria-label="Next match"
            disabled={totalMatches === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(1)}
          >
            ↓
          </button>
          <button
            type="button"
            title="Close (Esc)"
            aria-label="Close search"
            onClick={() => setSearchOpen(false)}
          >
            ✕
          </button>
        </div>
      ) : null}
      <div
        className="events"
        ref={containerRef}
        onScroll={() => {
          const el = containerRef.current;
          if (!el) return;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {visible.map((event, index) => {
          const { label, summary, tone, pretty } = described[index];
          const starts = matchStarts[index];
          return (
            <article key={event.id} className={tone === "error" ? "event-error" : undefined}>
              <div className="event-line">
                <span className="event-kind">
                  {highlightMatches(label, needle, starts.label, current)}
                </span>
                <div
                  className={
                    event.kind === "tool_call" ? "event-summary mono" : "event-summary"
                  }
                >
                  {summary ? (
                    <MarkdownText
                      text={summary}
                      needle={needle}
                      firstIndex={starts.summary}
                      currentIndex={current}
                    />
                  ) : (
                    <em>no details</em>
                  )}
                </div>
                <AbsoluteTime value={event.created_at} />
              </div>
              <details>
                <summary>payload</summary>
                <pre>{highlightMatches(pretty, needle, starts.payload, current)}</pre>
              </details>
            </article>
          );
        })}
        {!follow && live ? (
          <button
            type="button"
            className="jump-latest"
            onClick={() => {
              const el = containerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setFollow(true);
            }}
          >
            Jump to latest ↓
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RunTable({
  runs,
  onOpenRun,
  emptyTitle,
  emptyText,
  actionLabel,
  actionDisabled,
  onAction,
  activeRunIds,
  selectedRunId,
  lastActivity,
  showRepo,
}: {
  runs: RunWithIssueRow[];
  onOpenRun: (id: string) => void;
  emptyTitle?: string;
  emptyText?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
  activeRunIds?: Set<string>;
  selectedRunId?: string;
  lastActivity?: Map<string, string>;
  showRepo?: boolean;
}) {
  if (runs.length === 0) {
    return (
      <Empty
        title={emptyTitle ?? "No runs"}
        text={emptyText}
        actionLabel={actionLabel}
        actionDisabled={actionDisabled}
        onAction={onAction}
      />
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Issue</th>
          <th>Run</th>
          <th>Status</th>
          <th>Created</th>
          {lastActivity ? <th>Last activity</th> : null}
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr
            key={run.id}
            className={
              run.id === selectedRunId ? "clickable-row selected" : "clickable-row"
            }
            tabIndex={0}
            role="button"
            aria-label={`Open run ${run.issue_identifier} number ${run.run_number}`}
            aria-current={run.id === selectedRunId ? "true" : undefined}
            onClick={() => onOpenRun(run.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenRun(run.id);
              }
            }}
          >
            <td>
              <strong>
                {run.issue_identifier}
                {showRepo && run.repo_name ? (
                  <span className="repo-badge">{run.repo_name}</span>
                ) : null}
                {activeRunIds?.has(run.id) ? <span className="pulse" /> : null}
              </strong>
              <small>{run.issue_title}</small>
              {run.error_message ? (
                <small className="row-error" title={run.error_message}>
                  {run.error_class ? `${run.error_class}: ` : ""}
                  {run.error_message}
                </small>
              ) : null}
            </td>
            <td>#{run.run_number}</td>
            <td><Badge status={run.status} /></td>
            <td className="tnum">
              <RelativeTime value={run.created_at} />
            </td>
            {lastActivity ? (
              <td className="tnum">
                {lastActivity.has(run.id)
                  ? <RelativeTime value={lastActivity.get(run.id)!} />
                  : "—"}
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


export default RunsView;
