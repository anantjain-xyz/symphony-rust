import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  IssueRow,
  Overview,
  RunDetail,
  RunWithIssueRow,
  ValidationResult,
  WorkerStatus,
} from "./bindings";
import { nullable, prettyPayload, shortTime } from "./format";
import "./App.css";

type View = "overview" | "runs" | "issues" | "settings";

const emptyOverview: Overview = {
  active_runs: [],
  retry_queue: [],
  recent_failures: [],
  live_sessions: [],
  worker_heartbeat: null,
  rate_limits: [],
};

function App() {
  const [view, setView] = useState<View>("overview");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [linearKey, setLinearKey] = useState("");
  const [overview, setOverview] = useState<Overview>(emptyOverview);
  const [runs, setRuns] = useState<RunWithIssueRow[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [worker, setWorker] = useState<WorkerStatus>({
    state: "stopped",
    started_at: null,
    last_error: null,
  });
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [nextSettings, nextOverview, nextRuns, nextIssues, nextWorker] =
      await Promise.all([
        invoke<AppSettings>("load_settings"),
        invoke<Overview>("get_overview"),
        invoke<RunWithIssueRow[]>("list_runs"),
        invoke<IssueRow[]>("list_issues"),
        invoke<WorkerStatus>("get_worker_status"),
      ]);
    setSettings(nextSettings);
    setOverview(nextOverview);
    setRuns(nextRuns);
    setIssues(nextIssues);
    setWorker(nextWorker);
  }

  useEffect(() => {
    refresh().catch((err) => setError(String(err)));
    const unsubs = [
      listen("db_changed", () => refresh().catch(() => undefined)),
      listen("agent_event", () => refresh().catch(() => undefined)),
      listen("rate_limit_changed", () => refresh().catch(() => undefined)),
    ];
    return () => {
      Promise.all(unsubs).then((items) => items.forEach((unlisten) => unlisten()));
    };
  }, []);

  const activeRunIds = useMemo(
    () => new Set(overview.active_runs.map((run) => run.id)),
    [overview.active_runs],
  );

  async function call<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    if (!settings) return;
    const saved = await call(() =>
      invoke<AppSettings>("save_settings", {
        request: {
          settings,
          linear_api_key: linearKey.trim() ? linearKey : null,
        },
      }),
    );
    setSettings(saved);
    setLinearKey("");
  }

  async function validate() {
    if (!settings) return;
    const result = await call(() =>
      invoke<ValidationResult>("validate_settings", { settings }),
    );
    setValidation(result);
  }

  async function startWorker() {
    const status = await call(() => invoke<WorkerStatus>("start_worker"));
    setWorker(status);
  }

  async function stopWorker() {
    const status = await call(() => invoke<WorkerStatus>("stop_worker"));
    setWorker(status);
  }

  async function openRun(id: string) {
    const detail = await call(() =>
      invoke<RunDetail | null>("get_run_detail", { id }),
    );
    setSelectedRun(detail);
    setView("runs");
  }

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <h1>Symphony</h1>
            <p>Desktop operator</p>
          </div>
        </div>

        <nav>
          {(["overview", "runs", "issues", "settings"] as View[]).map((item) => (
            <button
              key={item}
              className={view === item ? "nav-active" : ""}
              onClick={() => setView(item)}
            >
              {label(item)}
            </button>
          ))}
        </nav>

        <div className="worker-panel">
          <span className={`status-dot ${worker.state}`} />
          <div>
            <strong>{worker.state}</strong>
            <small>{worker.started_at ? shortTime(worker.started_at) : "not started"}</small>
          </div>
          {worker.state === "running" ? (
            <button className="icon-button" disabled={busy} onClick={stopWorker} title="Stop worker">
              ■
            </button>
          ) : (
            <button className="icon-button" disabled={busy} onClick={startWorker} title="Start worker">
              ▶
            </button>
          )}
        </div>
      </aside>

      <section className="content">
        {error ? <div className="banner error">{error}</div> : null}
        {worker.last_error ? <div className="banner">{worker.last_error}</div> : null}

        {view === "overview" ? (
          <OverviewView overview={overview} onOpenRun={openRun} />
        ) : null}
        {view === "runs" ? (
          <RunsView
            runs={runs}
            selected={selectedRun}
            activeRunIds={activeRunIds}
            onOpenRun={openRun}
          />
        ) : null}
        {view === "issues" ? <IssuesView issues={issues} /> : null}
        {view === "settings" && settings ? (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            linearKey={linearKey}
            setLinearKey={setLinearKey}
            validation={validation}
            busy={busy}
            onSave={saveSettings}
            onValidate={validate}
          />
        ) : null}
      </section>
    </main>
  );
}

function OverviewView({
  overview,
  onOpenRun,
}: {
  overview: Overview;
  onOpenRun: (id: string) => void;
}) {
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Overview</h2>
          <p>Local worker state, retries, failures, and provider limits.</p>
        </div>
        <div className="kpis">
          <Kpi label="Active" value={overview.active_runs.length} />
          <Kpi label="Retries" value={overview.retry_queue.length} />
          <Kpi label="Failures" value={overview.recent_failures.length} />
        </div>
      </header>

      <div className="grid two">
        <Panel title="Active runs">
          <RunTable runs={overview.active_runs} onOpenRun={onOpenRun} empty="No active runs" />
        </Panel>
        <Panel title="Retry queue">
          {overview.retry_queue.length === 0 ? (
            <Empty text="No scheduled retries" />
          ) : (
            <table>
              <tbody>
                {overview.retry_queue.map((retry) => (
                  <tr key={retry.issue_id}>
                    <td>
                      <strong>{retry.issue_identifier}</strong>
                      <small>{retry.issue_title}</small>
                    </td>
                    <td>#{retry.run_number}</td>
                    <td>{shortTime(retry.due_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid two">
        <Panel title="Recent failures">
          <RunTable
            runs={overview.recent_failures}
            onOpenRun={onOpenRun}
            empty="No recent failures"
          />
        </Panel>
        <Panel title="Rate limits">
          {overview.rate_limits.length === 0 ? (
            <Empty text="No active rate-limit signals" />
          ) : (
            <table>
              <tbody>
                {overview.rate_limits.map((limit) => (
                  <tr key={limit.source}>
                    <td>
                      <strong>{limit.source}</strong>
                      <small>updated {shortTime(limit.updated_at)}</small>
                    </td>
                    <td>{limit.remaining ?? "unknown"}</td>
                    <td>{limit.reset_at ? shortTime(limit.reset_at) : "no reset"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

function RunsView({
  runs,
  selected,
  activeRunIds,
  onOpenRun,
}: {
  runs: RunWithIssueRow[];
  selected: RunDetail | null;
  activeRunIds: Set<string>;
  onOpenRun: (id: string) => void;
}) {
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Runs</h2>
          <p>Dispatch history and live agent event stream.</p>
        </div>
      </header>
      <div className="split">
        <Panel title="Run history">
          <RunTable runs={runs} onOpenRun={onOpenRun} empty="No runs yet" activeRunIds={activeRunIds} />
        </Panel>
        <Panel title={selected ? selected.run.issue_identifier : "Event stream"}>
          {!selected ? (
            <Empty text="Select a run to inspect events" />
          ) : selected.events.length === 0 ? (
            <Empty text="No events recorded for this run" />
          ) : (
            <div className="events">
              {selected.events.map((event) => (
                <article key={event.id}>
                  <div>
                    <strong>{event.kind}</strong>
                    <time>{shortTime(event.created_at)}</time>
                  </div>
                  <pre>{prettyPayload(event.payload)}</pre>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function IssuesView({ issues }: { issues: IssueRow[] }) {
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Issues</h2>
          <p>Normalized Linear cache stored locally in SQLite.</p>
        </div>
      </header>
      <Panel title="Issue cache">
        {issues.length === 0 ? (
          <Empty text="No issues cached yet" />
        ) : (
          <table>
            <tbody>
              {issues.map((issue) => (
                <tr key={issue.id}>
                  <td>
                    <strong>{issue.identifier}</strong>
                    <small>{issue.title}</small>
                  </td>
                  <td>{issue.state}</td>
                  <td>{issue.priority}</td>
                  <td>{shortTime(issue.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function SettingsView({
  settings,
  setSettings,
  linearKey,
  setLinearKey,
  validation,
  busy,
  onSave,
  onValidate,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  linearKey: string;
  setLinearKey: (value: string) => void;
  validation: ValidationResult | null;
  busy: boolean;
  onSave: () => void;
  onValidate: () => void;
}) {
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Settings</h2>
          <p>First-run configuration, workflow source, and local paths.</p>
        </div>
        <div className="actions">
          <button disabled={busy} onClick={onValidate}>Validate</button>
          <button disabled={busy} className="primary" onClick={onSave}>Save</button>
        </div>
      </header>

      <div className="settings-grid">
        <label>
          Repo URL
          <input
            value={settings.repo_url}
            onChange={(e) => setSettings({ ...settings, repo_url: e.currentTarget.value })}
            placeholder="git@github.com:org/repo.git"
          />
        </label>
        <label>
          Linear API key
          <input
            value={linearKey}
            type="password"
            onChange={(e) => setLinearKey(e.currentTarget.value)}
            placeholder={settings.linear_api_key_set ? "Stored in keychain" : "lin_api_..."}
          />
        </label>
        <label>
          Linear workspace
          <input
            value={settings.tracker_workspace ?? ""}
            onChange={(e) =>
              setSettings({ ...settings, tracker_workspace: nullable(e.currentTarget.value) })
            }
          />
        </label>
        <label>
          Tracker prefix
          <input
            value={settings.tracker_prefix ?? ""}
            onChange={(e) =>
              setSettings({ ...settings, tracker_prefix: nullable(e.currentTarget.value) })
            }
          />
        </label>
        <label>
          Project ID
          <input
            value={settings.tracker_project_id ?? ""}
            onChange={(e) =>
              setSettings({ ...settings, tracker_project_id: nullable(e.currentTarget.value) })
            }
          />
        </label>
        <label>
          Agent backend
          <select
            value={settings.agent_backend}
            onChange={(e) =>
              setSettings({ ...settings, agent_backend: e.currentTarget.value as AppSettings["agent_backend"] })
            }
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
      </div>

      {validation ? (
        <div className={validation.workflow_ok ? "banner ok" : "banner error"}>
          Workflow {validation.workflow_ok ? "valid" : validation.workflow_error}
          <span>codex: {validation.codex_found ? "found" : "missing"}</span>
          <span>claude: {validation.claude_found ? "found" : "missing"}</span>
        </div>
      ) : null}

      <Panel title="Workflow">
        <textarea
          value={settings.workflow_source}
          onChange={(e) => setSettings({ ...settings, workflow_source: e.currentTarget.value })}
          spellCheck={false}
        />
      </Panel>
    </>
  );
}

function RunTable({
  runs,
  onOpenRun,
  empty,
  activeRunIds,
}: {
  runs: RunWithIssueRow[];
  onOpenRun: (id: string) => void;
  empty: string;
  activeRunIds?: Set<string>;
}) {
  if (runs.length === 0) return <Empty text={empty} />;
  return (
    <table>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} onClick={() => onOpenRun(run.id)}>
            <td>
              <strong>
                {run.issue_identifier}
                {activeRunIds?.has(run.id) ? <span className="pulse" /> : null}
              </strong>
              <small>{run.issue_title}</small>
            </td>
            <td>#{run.run_number}</td>
            <td><Badge status={run.status} /></td>
            <td>{shortTime(run.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

function label(view: View) {
  return view[0].toUpperCase() + view.slice(1);
}

export default App;
