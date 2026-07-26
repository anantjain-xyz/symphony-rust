import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type {
  RetroBatchRow,
  RetroDetail,
  RetroReport,
  RetroRow,
  RetroStatus,
  RetroSuggestionRow,
} from "../bindings";
import { shortTime, statusSlug } from "../format";
import { RelativeTime } from "../RelativeTime";
import { retroRepoBatchState } from "../viewHelpers";
import "./RetroView.css";

function RetroView({
  retros,
  status,
  selected,
  runtimeAvailable,
  busy,
  settingsDirty,
  setupBlocked,
  onStartRetro,
  onOpenRetro,
  onDeleteRetro,
  onDecideSuggestion,
  onApplyWorkflow,
  onCreatePrs,
}: {
  retros: RetroRow[];
  status: RetroStatus;
  selected: RetroDetail | null;
  runtimeAvailable: boolean;
  busy: boolean;
  settingsDirty: boolean;
  setupBlocked: boolean;
  onStartRetro: () => void;
  onOpenRetro: (id: string) => void;
  onDeleteRetro: (id: string) => void;
  onDecideSuggestion: (id: string, decision: string) => void;
  onApplyWorkflow: (retroId: string) => void;
  onCreatePrs: (retroId: string) => void;
}) {
  const [reviewFilter, setReviewFilter] = useState<
    "all" | "pending" | "accepted" | "rejected"
  >("pending");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteTimer = useRef<number | null>(null);
  const activeReport = selected ? selected.report : status.report;
  const actionable = selected?.suggestions ?? [];
  const readySuggestions = actionable.filter(
    (suggestion) => suggestion.proposal_status === "ready",
  );
  const pendingCount = readySuggestions.filter(
    (suggestion) => suggestion.decision === "pending",
  ).length;
  const accepted = readySuggestions.filter(
    (suggestion) => suggestion.decision === "accepted",
  );
  const rejectedCount = readySuggestions.filter(
    (suggestion) => suggestion.decision === "rejected",
  ).length;
  const filteredSuggestions = actionable.filter(
    (suggestion) => reviewFilter === "all" || suggestion.decision === reviewFilter,
  );
  const emptyFilterCopy = {
    all: {
      title: "No suggestions",
      text: "This retro has no suggestions to show.",
    },
    pending: {
      title: "No pending suggestions",
      text: "Every available suggestion in this retro has been reviewed.",
    },
    accepted: {
      title: "No accepted suggestions",
      text: "Accept a pending suggestion to include it in an implementation batch.",
    },
    rejected: {
      title: "No rejected suggestions",
      text: "Suggestions you reject will appear here.",
    },
  }[reviewFilter];
  const acceptedPromptCount = accepted.filter(
    (suggestion) => suggestion.target_type === "prompt",
  ).length;
  const acceptedRepoSuggestions = accepted.filter(
    (suggestion) =>
      suggestion.target_type === "skill" || suggestion.target_type === "repo_workflow",
  );
  const acceptedRepoNames = new Set(
    acceptedRepoSuggestions.map((suggestion) => suggestion.repo_name),
  );
  const workflowLocked =
    selected?.batches.some(
      (batch) =>
        batch.kind === "workflow_update" &&
        ["queued", "running", "completed"].includes(batch.state),
    ) ?? false;
  const workflowStale =
    selected?.batches.some(
      (batch) => batch.kind === "workflow_update" && batch.state === "stale",
    ) ?? false;
  const workflowBlocked = workflowLocked || workflowStale;
  const eligibleRepoNames = new Set(
    [...acceptedRepoNames].filter(
      (repoName) => retroRepoBatchState(selected?.batches ?? [], repoName) === "available",
    ),
  );
  const staleRepoCount = [...acceptedRepoNames].filter(
    (repoName) => retroRepoBatchState(selected?.batches ?? [], repoName) === "stale",
  ).length;
  const canStart =
    !busy && status.state !== "running" && (!runtimeAvailable || !setupBlocked);
  const deletionBlocked =
    status.state === "running" ||
    selected?.row.status === "running" ||
    selected?.batches.some((batch) => ["queued", "running"].includes(batch.state)) ||
    false;
  const deleteConfirmationActive = confirmDeleteId === selected?.row.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing the selected retro is the effect's explicit reset signal.
  useEffect(() => {
    setConfirmDeleteId(null);
    if (confirmDeleteTimer.current !== null) {
      window.clearTimeout(confirmDeleteTimer.current);
      confirmDeleteTimer.current = null;
    }
    return () => {
      if (confirmDeleteTimer.current !== null) {
        window.clearTimeout(confirmDeleteTimer.current);
        confirmDeleteTimer.current = null;
      }
    };
  }, [selected?.row.id]);

  function requestDeleteRetro() {
    if (!selected || busy || deletionBlocked) return;
    if (!deleteConfirmationActive) {
      setConfirmDeleteId(selected.row.id);
      if (confirmDeleteTimer.current !== null) {
        window.clearTimeout(confirmDeleteTimer.current);
      }
      confirmDeleteTimer.current = window.setTimeout(() => {
        setConfirmDeleteId(null);
        confirmDeleteTimer.current = null;
      }, 4000);
      return;
    }
    if (confirmDeleteTimer.current !== null) {
      window.clearTimeout(confirmDeleteTimer.current);
      confirmDeleteTimer.current = null;
    }
    setConfirmDeleteId(null);
    onDeleteRetro(selected.row.id);
  }
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Retro</h2>
          <p>
            Finds repeated confusion in runs and workpads, then suggests prompt or
            skill changes per repo.
          </p>
        </div>
        <div className="actions">
          {selected ? (
            <button
              type="button"
              className={`danger${deleteConfirmationActive ? " confirm" : ""}`}
              disabled={busy || deletionBlocked}
              title={
                deletionBlocked
                  ? "Wait for Retro generation and change batches to finish before deleting."
                  : deleteConfirmationActive
                    ? "Delete this Retro and roll the generation marker back"
                    : "Delete this Retro so its run window can be generated again"
              }
              onClick={requestDeleteRetro}
            >
              {deleteConfirmationActive ? "Confirm delete" : "Delete retro"}
            </button>
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={!canStart}
            onClick={onStartRetro}
            title={
              setupBlocked && runtimeAvailable
                ? "Connect Linear and configure a repository before running a retro."
                : undefined
            }
          >
            {status.state === "running" ? "Generating..." : "Generate retro"}
          </button>
        </div>
      </header>

      {status.state === "running" ? (
        <div className="banner info">
          <strong>Retro running</strong>
          <span>{status.message ?? "Analyzing recent runs..."}</span>
        </div>
      ) : null}
      {status.state === "failed" && status.error ? (
        <div className="banner error">
          <strong>Retro failed</strong>
          <span>{status.error}</span>
        </div>
      ) : null}

      <div className="split retro-layout">
        <Panel title="Retro history">
          {retros.length === 0 ? (
            <Empty
              title="No retros yet"
              text="Generate the first retro to create a durable marker for the next run window."
              actionLabel="Generate retro"
              actionDisabled={!canStart}
              onAction={onStartRetro}
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Status</th>
                  <th>Runs</th>
                  <th>Issues</th>
                </tr>
              </thead>
              <tbody>
                {retros.map((retro) => (
                  // biome-ignore lint/a11y/useSemanticElements: a table row cannot be replaced by a button without breaking table semantics.
                  <tr
                    key={retro.id}
                    className={
                      selected?.row.id === retro.id
                        ? "clickable-row selected"
                        : "clickable-row"
                    }
                    tabIndex={0}
                    role="button"
                    aria-label={`Open retro from ${shortTime(retro.since_at)}`}
                    onClick={() => onOpenRetro(retro.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenRetro(retro.id);
                      }
                    }}
                  >
                    <td>
                      <strong>
                        <RelativeTime value={retro.created_at} />
                      </strong>
                      <small>
                        {shortTime(retro.since_at)} to {shortTime(retro.until_at)}
                      </small>
                      {retro.error_message ? (
                        <small className="row-error">{retro.error_message}</small>
                      ) : null}
                    </td>
                    <td>
                      <Badge status={retro.status} />
                    </td>
                    <td className="tnum">{retro.run_count}</td>
                    <td className="tnum">{retro.issue_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={actionable.length > 0 ? "Review suggestions" : "Findings and suggestions"}>
          {!activeReport ? (
            <Empty
              title="No report selected"
              text="Generate or select a retro to inspect repo-level confusion patterns."
            />
          ) : activeReport.repos.length === 0 ? (
            <Empty
              title="No runs in this window"
              text="The retro marker was advanced, but no terminal runs finished in the selected period."
            />
          ) : actionable.length > 0 && selected ? (
            <div className="retro-review">
              <div className="retro-review-summary">
                <div>
                  <strong>
                    {readySuggestions.length - pendingCount} of {readySuggestions.length} reviewed
                  </strong>
                  <small>
                    {accepted.length} accepted · {rejectedCount} rejected
                    {actionable.length - readySuggestions.length > 0
                      ? ` · ${actionable.length - readySuggestions.length} unavailable`
                      : ""}
                  </small>
                </div>
                {/* biome-ignore lint/a11y/useSemanticElements: this is an inline button group, not a form fieldset. */}
                <div className="retro-filter" role="group" aria-label="Filter suggestions">
                  {(["pending", "accepted", "rejected", "all"] as const).map((filter) => (
                    <button
                      type="button"
                      key={filter}
                      className={reviewFilter === filter ? "active" : undefined}
                      aria-pressed={reviewFilter === filter}
                      onClick={() => setReviewFilter(filter)}
                    >
                      {filter === "all"
                        ? "All"
                        : `${filter.charAt(0).toUpperCase()}${filter.slice(1)}`}
                    </button>
                  ))}
                </div>
              </div>

              {filteredSuggestions.length === 0 ? (
                <Empty title={emptyFilterCopy.title} text={emptyFilterCopy.text} />
              ) : (
                activeReport.repos.map((repo) => (
                  <RetroReviewRepo
                    key={repo.repo_name}
                    repo={repo}
                    suggestions={filteredSuggestions.filter(
                      (suggestion) => suggestion.repo_name === repo.repo_name,
                    )}
                    busy={busy}
                    runtimeAvailable={runtimeAvailable}
                    workflowLocked={workflowLocked}
                    repoLocked={
                      retroRepoBatchState(selected.batches, repo.repo_name) === "locked"
                    }
                    onDecide={onDecideSuggestion}
                  />
                ))
              )}

              {selected.batches.length > 0 ? (
                <RetroBatchResults batches={selected.batches} />
              ) : null}

              <div className="retro-action-bar">
                <div>
                  <strong>
                    {pendingCount === 0 ? "Review complete" : `${pendingCount} remaining`}
                  </strong>
                  <small>
                    {accepted.length === 0
                      ? "Accept a change to create an implementation batch."
                      : `${accepted.length} accepted change${accepted.length === 1 ? "" : "s"}`}
                  </small>
                </div>
                <div className="actions">
                  {acceptedPromptCount > 0 ? (
                    <button
                      type="button"
                      disabled={
                        !runtimeAvailable ||
                        busy ||
                        settingsDirty ||
                        pendingCount > 0 ||
                        workflowBlocked
                      }
                      title={
                        settingsDirty
                          ? "Save or discard the current Settings edits before applying a workflow change."
                          : undefined
                      }
                      onClick={() => onApplyWorkflow(selected.row.id)}
                    >
                      {workflowStale
                        ? "Generate a new retro"
                        : workflowLocked
                          ? "Workflow action started"
                          : `Apply default workflow (${acceptedPromptCount})`}
                    </button>
                  ) : null}
                  {acceptedRepoNames.size > 0 ? (
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        !runtimeAvailable ||
                        busy ||
                        pendingCount > 0 ||
                        eligibleRepoNames.size === 0
                      }
                      onClick={() => onCreatePrs(selected.row.id)}
                    >
                      {eligibleRepoNames.size > 0
                        ? `Create ${eligibleRepoNames.size} implementation PR${eligibleRepoNames.size === 1 ? "" : "s"}`
                        : staleRepoCount > 0
                        ? "Generate a new retro"
                        : "PR creation started"}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="retro-report">
              {activeReport.repos.map((repo) => (
                <LegacyRetroRepoCard key={repo.repo_name} repo={repo} />
              ))}
              <div className="banner info retro-legacy-banner">
                <strong>Historical report</strong>
                <span>Generate a new retro to review exact diffs and create change batches.</span>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function RetroReviewRepo({
  repo,
  suggestions,
  busy,
  runtimeAvailable,
  workflowLocked,
  repoLocked,
  onDecide,
}: {
  repo: RetroReport["repos"][number];
  suggestions: RetroSuggestionRow[];
  busy: boolean;
  runtimeAvailable: boolean;
  workflowLocked: boolean;
  repoLocked: boolean;
  onDecide: (id: string, decision: string) => void;
}) {
  if (suggestions.length === 0) return null;
  const reviewed = suggestions.filter((suggestion) => suggestion.decision !== "pending").length;
  return (
    <section className="retro-review-repo">
      <header>
        <div>
          <span className="repo-badge">{repo.repo_name}</span>
          <small>
            {reviewed} of {suggestions.length} reviewed
          </small>
        </div>
        <div className="retro-mini-stats">
          <span>{repo.run_count} runs</span>
          <span>{repo.failure_count} failures</span>
          <span>{repo.retry_count} retries</span>
        </div>
      </header>
      <div className="retro-suggestion-list">
        {suggestions.map((suggestion) => {
          const finding = repo.findings[suggestion.finding_index];
          const locked =
            suggestion.target_type === "prompt" ? workflowLocked : repoLocked;
          return (
            <article
              className={`retro-suggestion-card decision-${suggestion.decision}`}
              key={suggestion.id}
            >
              <header>
                <div>
                  <strong>{suggestion.title}</strong>
                  <small>{suggestion.target_path}</small>
                </div>
                <div className="retro-suggestion-badges">
                  <span className="retro-target">
                    {suggestion.target_type === "repo_workflow"
                      ? "repo workflow"
                      : suggestion.target_type}
                  </span>
                  <Badge status={finding?.severity ?? suggestion.confidence} />
                  {finding ? (
                    <span className="retro-occurrence-tag">
                      {finding.occurrences} occurrence
                      {finding.occurrences === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
              </header>

              {suggestion.proposal_status === "ready" && suggestion.unified_diff ? (
                <UnifiedDiff diff={suggestion.unified_diff} />
              ) : (
                <div className="banner error retro-proposal-error">
                  <strong>Diff unavailable</strong>
                  <span>{suggestion.proposal_error ?? "The proposal could not be prepared."}</span>
                </div>
              )}

              <details className="retro-rationale">
                <summary>Why this change?</summary>
                <p>{suggestion.rationale}</p>
                {finding ? (
                  <>
                    <p>{finding.detail}</p>
                    <ul className="retro-evidence">
                      {finding.evidence.map((evidence) => (
                        <li
                          key={`${suggestion.id}-${evidence.issue_identifier}-${evidence.event_id ?? evidence.summary}`}
                        >
                          <code>{evidence.issue_identifier}</code>
                          <small>{evidence.summary}</small>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </details>

              {suggestion.proposal_status === "ready" ? (
                <footer>
                  <small title={suggestion.base_ref ?? undefined}>
                    Base {suggestion.base_ref?.slice(0, 8) ?? "unknown"}
                  </small>
                  <div className="actions">
                    {suggestion.decision === "pending" ? (
                      <>
                        <button
                          type="button"
                          disabled={(busy && runtimeAvailable) || locked}
                          onClick={() => onDecide(suggestion.id, "rejected")}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          className="primary"
                          disabled={(busy && runtimeAvailable) || locked}
                          onClick={() => onDecide(suggestion.id, "accepted")}
                        >
                          Accept
                        </button>
                      </>
                    ) : (
                      <div className="retro-decision-state">
                        <span className={`retro-decision-label ${suggestion.decision}`}>
                          {suggestion.decision === "accepted" ? "Accepted" : "Rejected"}
                        </span>
                        <button
                          type="button"
                          className="retro-undo-button"
                          aria-label={`Undo ${suggestion.decision} decision`}
                          title={`Undo ${suggestion.decision}`}
                          disabled={(busy && runtimeAvailable) || locked}
                          onClick={() => onDecide(suggestion.id, "pending")}
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M6.5 3.5 3 7l3.5 3.5" />
                            <path d="M3.5 7h5a4.5 4.5 0 0 1 4.5 4.5" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                </footer>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function UnifiedDiff({ diff }: { diff: string }) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the labeled pre is the accessible diff region exercised by the review UI.
    <pre className="retro-diff" aria-label="Proposed unified diff">
      <code>
        {diff.split("\n").map((line, index) => {
          const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
            ? "meta"
            : line.startsWith("+")
              ? "addition"
              : line.startsWith("-")
                ? "deletion"
                : "context";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: unified diffs can contain duplicate lines with no stable identifier.
            <span className={`diff-${kind}`} key={`${index}-${line}`}>
              {line || " "}
              {"\n"}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function RetroBatchResults({ batches }: { batches: RetroBatchRow[] }) {
  return (
    <section className="retro-batches">
      <h4>Change batches</h4>
      {batches.map((batch) => (
        <div className="retro-batch-row" key={batch.id}>
          <div>
            <strong>{batch.repo_name ?? "Workflow prompt"}</strong>
            <small>{batch.progress ?? batch.error ?? "Waiting for an update…"}</small>
            {batch.error ? <small className="row-error">{batch.error}</small> : null}
          </div>
          <Badge status={batch.state} />
          {batch.pr_url ? (
            <button
              type="button"
              onClick={() => {
                if (batch.pr_url) openUrl(batch.pr_url).catch(() => undefined);
              }}
            >
              View PR
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function LegacyRetroRepoCard({ repo }: { repo: RetroReport["repos"][number] }) {
  return (
    <article className="retro-repo-card">
      <header>
        <div className="retro-repo-title">
          <span className="repo-badge">{repo.repo_name}</span>
        </div>
        <div className="retro-mini-stats">
          <span>{repo.run_count} runs</span>
          <span>{repo.failure_count} failures</span>
          <span>{repo.retry_count} retries</span>
        </div>
      </header>
      <div className="retro-columns">
        <section>
          <h5>Confusion patterns</h5>
          {repo.findings.length === 0 ? (
            <small>No repeated confusion found for this repo.</small>
          ) : (
            <div className="retro-list">
              {repo.findings.map((finding) => (
                <div className="retro-item" key={`${finding.title}-${finding.detail}`}>
                  <div className="retro-item-head">
                    <strong>{finding.title}</strong>
                    <Badge status={finding.severity} />
                  </div>
                  <p>{finding.detail}</p>
                  <small>
                    {finding.occurrences} occurrence
                    {finding.occurrences === 1 ? "" : "s"}
                  </small>
                  <ul className="retro-evidence">
                    {finding.evidence.map((evidence) => (
                      <li
                        key={`${evidence.issue_identifier}-${evidence.run_id ?? evidence.kind}-${evidence.event_id ?? evidence.summary}`}
                      >
                        <code>{evidence.issue_identifier}</code>
                        <span>
                          {evidence.run_number ? `Run #${evidence.run_number}` : evidence.kind}
                        </span>
                        <small>{evidence.summary}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <h5>Suggested changes</h5>
          {repo.suggestions.length === 0 ? (
            <small>No prompt or skill changes suggested.</small>
          ) : (
            <div className="retro-list">
              {repo.suggestions.map((suggestion) => (
                <div className="retro-item" key={`${suggestion.target_id}-${suggestion.title}`}>
                  <div className="retro-item-head">
                    <strong>{suggestion.title}</strong>
                    <span className="retro-target">
                      {suggestion.target_type}: {suggestion.target_id}
                    </span>
                  </div>
                  <p>{suggestion.body}</p>
                  <small>
                    {suggestion.confidence} confidence · {suggestion.rationale}
                  </small>
                </div>
              ))}
            </div>
          )}
        </section>
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


export default RetroView;
