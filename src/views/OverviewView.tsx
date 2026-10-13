import type { Overview } from "../bindings";
import { formatTokens, providerRateLimits, providerTokenUsage } from "../format";
import { RelativeTime } from "../RelativeTime";
import { Empty, Panel, RunTable } from "../viewPrimitives";

type SetupState = {
  blocked: boolean;
  linearConnected: boolean;
  repoConfigured: boolean;
};

export function OverviewView({
  overview,
  canStartWorker,
  canTriggerRetry,
  workerRunning,
  setup,
  multiRepo,
  onOpenRun,
  onStartWorker,
  onTriggerRetryNow,
  triggeringRetryIds,
  onOpenSettings,
  onOpenIssues,
}: {
  overview: Overview;
  canStartWorker: boolean;
  canTriggerRetry: boolean;
  workerRunning: boolean;
  setup: SetupState;
  multiRepo: boolean;
  onOpenRun: (id: string) => void;
  onStartWorker: () => void;
  onTriggerRetryNow: (issueId: string) => void;
  triggeringRetryIds: Set<string>;
  onOpenSettings: () => void;
  onOpenIssues: () => void;
}) {
  // A run gets a live_sessions row only while it is actively streaming tokens.
  // Use that to pulse streaming rows and show their last-activity indicator in
  // the Active runs table (the panel this data used to live in on its own).
  const liveRunIds = new Set(overview.live_sessions.map((session) => session.run_id));
  const lastActivity = new Map<string, string>(
    overview.live_sessions.map((session): [string, string] => [
      session.run_id,
      session.last_event_at,
    ]),
  );
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Overview</h2>
          <p>Local worker state, retries, failures, cleanup, and provider limits and usage.</p>
        </div>
        <div className="kpis">
          <Kpi label="Active" value={overview.active_runs.length} />
          <Kpi
            label={overview.retry_count === 1 ? "Retry" : "Retries"}
            value={overview.retry_count}
          />
          <Kpi label="Cleanup" value={overview.workspace_cleanup_count} />
        </div>
      </header>

      {setup.blocked ? <SetupChecklist setup={setup} onOpenSettings={onOpenSettings} /> : null}

      <div className="grid">
        <Panel title="Active runs">
          <RunTable
            runs={overview.active_runs}
            onOpenRun={onOpenRun}
            activeRunIds={liveRunIds}
            lastActivity={lastActivity}
            showRepo={multiRepo}
            emptyTitle="No active runs"
            emptyText={
              setup.blocked
                ? "Finish setup before starting the worker."
                : workerRunning
                  ? "The worker is polling Linear. Move an issue to an active state (like Todo) to dispatch an agent."
                  : "Start the worker when you are ready to dispatch agent work."
            }
            actionLabel={
              setup.blocked ? "Open settings" : workerRunning ? "View issues" : "Start worker"
            }
            actionDisabled={setup.blocked || workerRunning ? false : !canStartWorker}
            onAction={setup.blocked ? onOpenSettings : workerRunning ? onOpenIssues : onStartWorker}
          />
        </Panel>
      </div>

      <div className="grid two">
        <Panel title="Recent failures">
          <RunTable
            runs={overview.recent_failures.slice(0, 5)}
            onOpenRun={onOpenRun}
            showRepo={multiRepo}
            emptyTitle="No recent failures"
            emptyText="Worker failures will be collected here for triage."
          />
        </Panel>
        <Panel title="Retry queue">
          {overview.retry_queue.length === 0 ? (
            <Empty
              title="No scheduled retries"
              text="Failed runs with retry windows will appear here."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Run</th>
                  <th>Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overview.retry_queue.map((retry) => (
                  <tr key={retry.issue_id}>
                    <td>
                      <strong>{retry.issue_identifier}</strong>
                      <small>{retry.issue_title}</small>
                    </td>
                    <td>#{retry.run_number}</td>
                    <td className="tnum">
                      <RelativeTime value={retry.due_at} />
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="link-button outlined"
                        disabled={!canTriggerRetry || triggeringRetryIds.has(retry.issue_id)}
                        title={
                          workerRunning
                            ? "Run this scheduled retry now"
                            : "Start the worker to retry now"
                        }
                        onClick={() => onTriggerRetryNow(retry.issue_id)}
                      >
                        {triggeringRetryIds.has(retry.issue_id) ? "Retrying..." : "Retry now"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid two">
        <Panel title="Rate limits">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Remaining</th>
                <th>Reset</th>
              </tr>
            </thead>
            <tbody>
              {providerRateLimits(overview.rate_limits).map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.label}</strong>
                    {row.limit ? (
                      <small>
                        signal <RelativeTime value={row.limit.updated_at} />
                      </small>
                    ) : (
                      <small>no limits hit</small>
                    )}
                  </td>
                  <td className="tnum">{row.limit?.remaining ?? "—"}</td>
                  <td className="tnum">
                    {row.limit ? (
                      row.limit.reset_at ? (
                        <>
                          resets <RelativeTime value={row.limit.reset_at} />
                        </>
                      ) : (
                        "no reset reported"
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Token usage">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Input</th>
                <th>Output</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {providerTokenUsage(overview.token_usage).map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.label}</strong>
                    {row.usage ? (
                      <small>
                        {row.usage.run_count} {row.usage.run_count === 1 ? "run" : "runs"} · last{" "}
                        <RelativeTime value={row.usage.updated_at} />
                      </small>
                    ) : (
                      <small>no usage yet</small>
                    )}
                  </td>
                  <td className="tnum">{row.usage ? formatTokens(row.usage.input_tokens) : "—"}</td>
                  <td className="tnum">
                    {row.usage ? formatTokens(row.usage.output_tokens) : "—"}
                  </td>
                  <td className="tnum">{row.usage ? formatTokens(row.usage.total_tokens) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}

function SetupChecklist({
  setup,
  onOpenSettings,
}: {
  setup: SetupState;
  onOpenSettings: () => void;
}) {
  return (
    <section className="setup-panel">
      <div className="setup-intro">
        <h3>Welcome to Symphony</h3>
        <p>
          Symphony watches your Linear project and dispatches Codex, Claude Code, or Cursor agents
          to work on issues in isolated workspaces. Finish the first two setup steps to start the
          worker.
        </p>
      </div>
      <ol className="setup-steps">
        <SetupStep
          done={setup.linearConnected}
          step={1}
          title="Connect Linear"
          text="Add your Linear API key so Symphony can read issues from your project."
        />
        <SetupStep
          done={setup.repoConfigured}
          step={2}
          title="Add your repositories"
          text="Each run clones the repo its issue routes to into a fresh workspace."
        />
      </ol>
      <div className="setup-actions">
        <button className="primary" type="button" onClick={onOpenSettings}>
          Open settings
        </button>
      </div>
    </section>
  );
}

function SetupStep({
  done,
  step,
  title,
  text,
}: {
  done: boolean;
  step: number;
  title: string;
  text: string;
}) {
  return (
    <li className={done ? "setup-step done" : "setup-step"}>
      <span className="setup-step-marker" aria-hidden="true">
        {done ? "✓" : step}
      </span>
      <div>
        <strong>{title}</strong>
        <small>{text}</small>
      </div>
    </li>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="kpi">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
