import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentEventRow,
  AppSettings,
  IssueRow,
  Overview,
  RunDetail,
  RunWithIssueRow,
  TrackerTestResult,
  ValidationResult,
  WorkerStatus,
} from "./bindings";
import {
  describeEvent,
  formatTokens,
  nullable,
  prettyPayload,
  priorityLabel,
  relativeTime,
  shortTime,
  statusSlug,
  timeOnly,
} from "./format";
import symphonyIcon from "./assets/symphony-app-icon.png";
import "./App.css";

type View = "overview" | "runs" | "issues" | "settings";
type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "symphony-theme";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggle = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  return [theme, toggle];
}

const emptyOverview: Overview = {
  active_runs: [],
  retry_queue: [],
  recent_failures: [],
  live_sessions: [],
  worker_heartbeat: null,
  rate_limits: [],
};

const previewSettings: AppSettings = {
  workflow_source:
    "# Workflow preview\n\nConnect through the Tauri desktop runtime to load and edit the saved workflow.",
  repo_url: "",
  tracker_workspace: null,
  tracker_prefix: null,
  tracker_project_id: null,
  workspace_root: null,
  install_cmd: null,
  agent_backend: "codex",
  linear_api_key_set: false,
};

// linear_api_key_set is server-derived, not part of the editable form.
function formSnapshot(settings: AppSettings) {
  const { linear_api_key_set: _ignored, ...form } = settings;
  return JSON.stringify(form);
}

function App() {
  const runtimeAvailable = isTauri();
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<View>("overview");
  const [settings, setSettings] = useState<AppSettings | null>(
    runtimeAvailable ? null : previewSettings,
  );
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
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [trackerTest, setTrackerTest] = useState<TrackerTestResult | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmStopTimer = useRef<number | null>(null);
  const savedFlashTimer = useRef<number | null>(null);

  const selectedRunIdRef = useRef<string | null>(null);

  // Dashboard data refreshes on worker events; settings load separately so
  // in-progress edits are never overwritten by background activity.
  async function refreshDashboard() {
    if (!runtimeAvailable) return;
    const detailId = selectedRunIdRef.current;
    const [nextOverview, nextRuns, nextIssues, nextWorker, nextDetail] =
      await Promise.all([
        invoke<Overview>("get_overview"),
        invoke<RunWithIssueRow[]>("list_runs"),
        invoke<IssueRow[]>("list_issues"),
        invoke<WorkerStatus>("get_worker_status"),
        detailId
          ? invoke<RunDetail | null>("get_run_detail", { id: detailId })
          : Promise.resolve(null),
      ]);
    setOverview(nextOverview);
    setRuns(nextRuns);
    setIssues(nextIssues);
    setWorker(nextWorker);
    if (detailId && detailId === selectedRunIdRef.current) {
      setSelectedRun(nextDetail);
      if (!nextDetail) selectedRunIdRef.current = null;
    }
  }

  useEffect(() => {
    if (!runtimeAvailable) return;

    invoke<AppSettings>("load_settings")
      .then((loaded) => {
        setSettings(loaded);
        setSavedSnapshot(formSnapshot(loaded));
      })
      .catch((err) => setError(formatError(err)));
    refreshDashboard().catch((err) => setError(formatError(err)));

    // Agent events arrive in bursts; coalesce them into a single refresh.
    let timer: number | null = null;
    const scheduleRefresh = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        refreshDashboard().catch(() => undefined);
      }, 300);
    };
    const unsubs = Promise.all([
      listen("db_changed", scheduleRefresh),
      listen("agent_event", scheduleRefresh),
      listen("rate_limit_changed", scheduleRefresh),
    ]).catch((err) => {
      setError(formatError(err));
      return [];
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubs.then((items) => items.forEach((unlisten) => unlisten()));
    };
  }, [runtimeAvailable]);

  useEffect(() => {
    if (!runtimeAvailable || worker.state === "stopped") return;

    let cancelled = false;
    const refreshWorker = () => {
      invoke<WorkerStatus>("get_worker_status")
        .then((nextWorker) => {
          if (!cancelled) {
            setWorker(nextWorker);
          }
        })
        .catch(() => undefined);
    };

    refreshWorker();
    const interval = window.setInterval(
      refreshWorker,
      worker.state === "stopping" ? 500 : 2000,
    );

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [runtimeAvailable, worker.state]);

  const activeRunIds = useMemo(
    () => new Set(overview.active_runs.map((run) => run.id)),
    [overview.active_runs],
  );

  // Keep relative timestamps fresh while the dashboard is otherwise idle.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  async function call<T>(fn: () => Promise<T>) {
    if (!runtimeAvailable) {
      setError("Connect through the Symphony desktop app to run this action.");
      return undefined as T;
    }
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(formatError(err));
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
    setSavedSnapshot(formSnapshot(saved));
    setLinearKey("");
    setSavedFlash(true);
    if (savedFlashTimer.current !== null) {
      window.clearTimeout(savedFlashTimer.current);
    }
    savedFlashTimer.current = window.setTimeout(() => setSavedFlash(false), 2500);
  }

  async function validate() {
    if (!settings) return;
    const result = await call(() =>
      invoke<ValidationResult>("validate_settings", { settings }),
    );
    setValidation(result);
  }

  async function testConnection() {
    if (!settings) return;
    const result = await call(() =>
      invoke<TrackerTestResult>("test_tracker_connection", {
        request: {
          settings,
          linear_api_key: linearKey.trim() ? linearKey : null,
        },
      }),
    );
    setTrackerTest(result);
  }

  async function removeLinearKey() {
    if (!settings) return;
    const fromDisk = await call(() =>
      invoke<AppSettings>("remove_linear_api_key"),
    );
    // Keep in-progress form edits; only the key flag changed.
    setSettings({ ...settings, linear_api_key_set: fromDisk.linear_api_key_set });
    setLinearKey("");
    setTrackerTest(null);
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
    selectedRunIdRef.current = detail?.run.id ?? null;
    setSelectedRun(detail);
    setView("runs");
  }

  const setup = {
    needed:
      settings !== null &&
      (!settings.linear_api_key_set || settings.repo_url.trim() === ""),
    linearConnected: settings?.linear_api_key_set ?? false,
    repoConfigured: (settings?.repo_url.trim() ?? "") !== "",
  };

  const dirty =
    settings !== null &&
    savedSnapshot !== null &&
    (formSnapshot(settings) !== savedSnapshot || linearKey.trim() !== "");

  // Revalidate when entering Settings (or once settings finish loading there),
  // so CLI detection and workflow status are visible without a manual click.
  useEffect(() => {
    if (!runtimeAvailable || view !== "settings" || !settings) return;
    invoke<ValidationResult>("validate_settings", { settings })
      .then(setValidation)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, runtimeAvailable, settings !== null]);

  function requestStop() {
    if (overview.active_runs.length > 0 && !confirmStop) {
      setConfirmStop(true);
      if (confirmStopTimer.current !== null) {
        window.clearTimeout(confirmStopTimer.current);
      }
      confirmStopTimer.current = window.setTimeout(
        () => setConfirmStop(false),
        4000,
      );
      return;
    }
    if (confirmStopTimer.current !== null) {
      window.clearTimeout(confirmStopTimer.current);
    }
    setConfirmStop(false);
    stopWorker();
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="topbar-primary">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <img className="brand-icon" src={symphonyIcon} alt="" />
            </div>
            <div>
              <h1>Symphony</h1>
            </div>
          </div>

          <nav className="topnav" aria-label="Primary">
            {(["overview", "runs", "issues", "settings"] as View[]).map((item) => (
              <button
                key={item}
                className={view === item ? "nav-active" : ""}
                aria-current={view === item ? "page" : undefined}
                onClick={() => setView(item)}
              >
                {label(item)}
              </button>
            ))}
          </nav>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <div className={`worker-pill ${worker.state}`} aria-live="polite">
            <span className={`status-dot ${worker.state}`} aria-hidden="true" />
            <div className="worker-status-copy">
              <strong>{worker.state}</strong>
              <small title={worker.started_at ? shortTime(worker.started_at) : undefined}>
                {confirmStop
                  ? `interrupts ${overview.active_runs.length} ${overview.active_runs.length === 1 ? "run" : "runs"}`
                  : worker.started_at
                    ? `started ${relativeTime(worker.started_at)}`
                    : "not started"}
              </small>
            </div>
            {worker.state === "running" ? (
              <button
                className={
                  confirmStop
                    ? "icon-button worker-action danger"
                    : "icon-button worker-action"
                }
                disabled={busy || !runtimeAvailable}
                onClick={requestStop}
                title={
                  confirmStop
                    ? `${overview.active_runs.length} active ${overview.active_runs.length === 1 ? "run" : "runs"} will be interrupted — click again to stop`
                    : "Stop worker"
                }
                aria-label={confirmStop ? "Confirm stop worker" : "Stop worker"}
              >
                <span aria-hidden="true">■</span>
              </button>
            ) : (
              <button
                className="icon-button worker-action"
                disabled={busy || !runtimeAvailable || worker.state === "stopping"}
                onClick={startWorker}
                title={worker.state === "stopping" ? "Worker is stopping" : "Start worker"}
                aria-label={worker.state === "stopping" ? "Worker is stopping" : "Start worker"}
              >
                <span aria-hidden="true">{worker.state === "stopping" ? "…" : "▶"}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <section className="content">
        {!runtimeAvailable ? (
          <RuntimeBanner
            title="Desktop runtime unavailable"
            message="This browser preview is disconnected from Tauri commands. Launch the desktop app to load live data, save settings, and start the worker."
          />
        ) : null}
        {error ? <div className="banner error">{error}</div> : null}
        {worker.last_error ? (
          <div className="banner error">
            <strong>Worker stopped</strong>
            <span>{friendlyError(worker.last_error)}</span>
          </div>
        ) : null}

        {view === "overview" ? (
          <OverviewView
            overview={overview}
            canStartWorker={runtimeAvailable && !busy && worker.state === "stopped"}
            setup={setup}
            onOpenRun={openRun}
            onStartWorker={startWorker}
            onOpenSettings={() => setView("settings")}
          />
        ) : null}
        {view === "runs" ? (
          <RunsView
            runs={runs}
            selected={selectedRun}
            activeRunIds={activeRunIds}
            onOpenRun={openRun}
          />
        ) : null}
        {view === "issues" ? (
          <IssuesView
            issues={issues}
            linearWorkspace={settings?.tracker_workspace ?? null}
            onOpenSettings={() => setView("settings")}
          />
        ) : null}
        {view === "settings" && settings ? (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            linearKey={linearKey}
            setLinearKey={setLinearKey}
            validation={validation}
            trackerTest={trackerTest}
            dirty={dirty}
            savedFlash={savedFlash}
            busy={busy}
            runtimeAvailable={runtimeAvailable}
            onSave={saveSettings}
            onValidate={validate}
            onTestConnection={testConnection}
            onRemoveKey={removeLinearKey}
          />
        ) : null}
      </section>
    </main>
  );
}

type SetupState = {
  needed: boolean;
  linearConnected: boolean;
  repoConfigured: boolean;
};

function OverviewView({
  overview,
  canStartWorker,
  setup,
  onOpenRun,
  onStartWorker,
  onOpenSettings,
}: {
  overview: Overview;
  canStartWorker: boolean;
  setup: SetupState;
  onOpenRun: (id: string) => void;
  onStartWorker: () => void;
  onOpenSettings: () => void;
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
          <Kpi
            label={overview.retry_queue.length === 1 ? "Retry" : "Retries"}
            value={overview.retry_queue.length}
          />
          <Kpi
            label={overview.recent_failures.length === 1 ? "Failure" : "Failures"}
            value={overview.recent_failures.length}
          />
        </div>
      </header>

      {setup.needed ? (
        <SetupChecklist setup={setup} onOpenSettings={onOpenSettings} />
      ) : null}

      <div className="status-strip">
        <StatusItem
          label="Heartbeat"
          value={
            overview.worker_heartbeat
              ? relativeTime(overview.worker_heartbeat.last_beat_at)
              : "No heartbeat"
          }
          title={
            overview.worker_heartbeat
              ? shortTime(overview.worker_heartbeat.last_beat_at)
              : undefined
          }
        />
        <StatusItem label="Live sessions" value={overview.live_sessions.length} />
        <StatusItem label="Rate limits" value={overview.rate_limits.length ? "Active signals" : "Clear"} tone={overview.rate_limits.length ? "warning" : "ok"} />
      </div>

      {overview.live_sessions.length > 0 ? (
        <div className="grid">
          <Panel title="Live sessions">
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Tokens</th>
                  <th>Started</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {overview.live_sessions.map((session) => {
                  const run = overview.active_runs.find(
                    (candidate) => candidate.id === session.run_id,
                  );
                  return (
                    <tr
                      key={session.run_id}
                      className="clickable-row"
                      tabIndex={0}
                      role="button"
                      aria-label={`Open run for ${run?.issue_identifier ?? session.session_id}`}
                      onClick={() => onOpenRun(session.run_id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onOpenRun(session.run_id);
                        }
                      }}
                    >
                      <td>
                        <strong>
                          {run?.issue_identifier ?? session.session_id}
                          <span className="pulse" />
                        </strong>
                        {run ? <small>{run.issue_title}</small> : null}
                      </td>
                      <td className="tnum">
                        <strong>{formatTokens(session.total_tokens)}</strong>
                        <small>
                          {formatTokens(session.input_tokens)} in ·{" "}
                          {formatTokens(session.output_tokens)} out
                        </small>
                      </td>
                      <td className="tnum" title={shortTime(session.started_at)}>
                        {relativeTime(session.started_at)}
                      </td>
                      <td className="tnum" title={shortTime(session.last_event_at)}>
                        {relativeTime(session.last_event_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </div>
      ) : null}

      <div className="grid two">
        <Panel title="Active runs">
          <RunTable
            runs={overview.active_runs}
            onOpenRun={onOpenRun}
            emptyTitle="No active runs"
            emptyText={
              setup.needed
                ? "Finish setup before starting the worker."
                : "Start the worker when you are ready to dispatch agent work."
            }
            actionLabel={setup.needed ? "Open settings" : "Start worker"}
            actionDisabled={setup.needed ? false : !canStartWorker}
            onAction={setup.needed ? onOpenSettings : onStartWorker}
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
                    <td className="tnum" title={shortTime(retry.due_at)}>
                      {relativeTime(retry.due_at)}
                    </td>
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
            emptyTitle="No recent failures"
            emptyText="Worker failures will be collected here for triage."
          />
        </Panel>
        <Panel title="Rate limits">
          {overview.rate_limits.length === 0 ? (
            <Empty
              title="No active rate-limit signals"
              text="Provider limits are clear. New limits will show reset timing here."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Remaining</th>
                  <th>Reset</th>
                </tr>
              </thead>
              <tbody>
                {overview.rate_limits.map((limit) => (
                  <tr key={limit.source}>
                    <td>
                      <strong>{limit.source}</strong>
                      <small title={shortTime(limit.updated_at)}>
                        updated {relativeTime(limit.updated_at)}
                      </small>
                    </td>
                    <td className="tnum">{limit.remaining ?? "unknown"}</td>
                    <td
                      className="tnum"
                      title={limit.reset_at ? shortTime(limit.reset_at) : undefined}
                    >
                      {limit.reset_at ? relativeTime(limit.reset_at) : "no reset"}
                    </td>
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
          Symphony watches your Linear project and dispatches Codex or Claude
          agents to work on issues in isolated workspaces. Finish setup to
          start the worker.
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
          title="Add your repository"
          text="Each run clones this repository into a fresh workspace."
        />
        <SetupStep
          done={false}
          step={3}
          title="Start the worker"
          text="Symphony polls Linear and dispatches an agent for each issue in an active state."
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
          <RunTable
            runs={runs}
            onOpenRun={onOpenRun}
            emptyTitle="No runs yet"
            emptyText="Runs will appear after the worker dispatches the first issue."
            activeRunIds={activeRunIds}
            selectedRunId={selected?.run.id}
          />
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
                <div className="run-meta-row">
                  <Badge status={selected.run.status} />
                  <span>{selected.run.issue_title}</span>
                </div>
                <div className="run-meta-row muted">
                  <span>Created {shortTime(selected.run.created_at)}</span>
                  {selected.run.ended_at ? (
                    <span>Ended {shortTime(selected.run.ended_at)}</span>
                  ) : null}
                </div>
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

function IssuesView({
  issues,
  linearWorkspace,
  onOpenSettings,
}: {
  issues: IssueRow[];
  linearWorkspace: string | null;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Issues</h2>
          <p>The Linear issues Symphony is watching, refreshed on every poll.</p>
        </div>
      </header>
      <Panel title="Watched issues">
        {issues.length === 0 ? (
          <Empty
            title="No issues yet"
            text="Once the worker connects to Linear, issues in your active states will appear here."
            actionLabel="Open settings"
            onAction={onOpenSettings}
          />
        ) : (
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
                  <td className="tnum" title={shortTime(issue.last_seen_at)}>
                    {relativeTime(issue.last_seen_at)}
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
                        Open ↗
                      </button>
                    </td>
                  ) : null}
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
  trackerTest,
  dirty,
  savedFlash,
  busy,
  runtimeAvailable,
  onSave,
  onValidate,
  onTestConnection,
  onRemoveKey,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  linearKey: string;
  setLinearKey: (value: string) => void;
  validation: ValidationResult | null;
  trackerTest: TrackerTestResult | null;
  dirty: boolean;
  savedFlash: boolean;
  busy: boolean;
  runtimeAvailable: boolean;
  onSave: () => void;
  onValidate: () => void;
  onTestConnection: () => void;
  onRemoveKey: () => void;
}) {
  return (
    <form
      className="settings-form"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <header className="page-header">
        <div>
          <h2>Settings</h2>
          <p>Linear connection, repository, agent backend, and the workflow that drives runs.</p>
        </div>
        <div className="actions">
          <span
            className={savedFlash ? "save-status ok" : "save-status"}
            aria-live="polite"
          >
            {savedFlash ? "Saved" : dirty ? "Unsaved changes" : ""}
          </span>
          <button disabled={busy || !runtimeAvailable} type="button" onClick={onValidate}>Validate</button>
          <button disabled={busy || !runtimeAvailable || !dirty} className="primary" type="submit">Save</button>
        </div>
      </header>

      {!runtimeAvailable ? (
        <div className="banner info">
          Settings are shown in preview mode. Open Symphony as a Tauri desktop app to edit, validate, and save configuration.
        </div>
      ) : null}

      <div className="settings-grid">
        <section className="settings-section">
          <h3>Repository</h3>
          <label>
            Repo URL
            <input
              value={settings.repo_url}
              disabled={!runtimeAvailable}
              autoComplete="off"
              onChange={(e) => setSettings({ ...settings, repo_url: e.currentTarget.value })}
              placeholder="git@github.com:org/repo.git"
            />
            <small className="hint">
              SSH or HTTPS Git URL. Each run clones it into a fresh workspace.
            </small>
          </label>
          <label>
            Install command
            <input
              value={settings.install_cmd ?? ""}
              disabled={!runtimeAvailable}
              autoComplete="off"
              onChange={(e) =>
                setSettings({ ...settings, install_cmd: nullable(e.currentTarget.value) })
              }
              placeholder="npm ci"
            />
            <small className="hint">
              Runs in the workspace after cloning. Leave blank for <code>npm ci</code>.
            </small>
          </label>
          <label>
            Workspace root
            <input
              value={settings.workspace_root ?? ""}
              disabled={!runtimeAvailable}
              autoComplete="off"
              onChange={(e) =>
                setSettings({ ...settings, workspace_root: nullable(e.currentTarget.value) })
              }
              placeholder="App data directory"
            />
            <small className="hint">
              Where per-run workspaces are created. Leave blank to use the app data directory.
            </small>
          </label>
        </section>

        <section className="settings-section">
          <h3>Linear</h3>
          <label>
            API key
            <input
              value={linearKey}
              disabled={!runtimeAvailable}
              type="password"
              autoComplete="new-password"
              onChange={(e) => setLinearKey(e.currentTarget.value)}
              placeholder={settings.linear_api_key_set ? "Stored in keychain" : "lin_api_..."}
            />
            <small className="hint">
              Create a personal API key under{" "}
              <ExternalLink href="https://linear.app/settings/account/security">
                Linear security settings
              </ExternalLink>
              . It is stored in the OS keychain, never on disk.
            </small>
          </label>
          {settings.linear_api_key_set ? (
            <button
              type="button"
              className="link-button self-start"
              disabled={busy || !runtimeAvailable}
              onClick={onRemoveKey}
            >
              Remove saved key
            </button>
          ) : null}
          <label>
            Workspace
            <input
              value={settings.tracker_workspace ?? ""}
              disabled={!runtimeAvailable}
              autoComplete="off"
              onChange={(e) =>
                setSettings({ ...settings, tracker_workspace: nullable(e.currentTarget.value) })
              }
              placeholder="acme"
            />
            <small className="hint">
              Your workspace slug — the first path segment in linear.app URLs. Enables issue links.
            </small>
          </label>
          <label>
            Project ID
            <input
              value={settings.tracker_project_id ?? ""}
              disabled={!runtimeAvailable}
              autoComplete="off"
              onChange={(e) =>
                setSettings({ ...settings, tracker_project_id: nullable(e.currentTarget.value) })
              }
            />
            <small className="hint">
              Optional. Watch a single project — copy its ID from the project details panel.
            </small>
          </label>
          <label>
            Team prefix
            <input
              value={settings.tracker_prefix ?? ""}
              disabled={!runtimeAvailable}
              autoComplete="off"
              onChange={(e) =>
                setSettings({ ...settings, tracker_prefix: nullable(e.currentTarget.value) })
              }
              placeholder="ENG"
            />
            <small className="hint">
              Optional. Watch only issues whose identifier starts with this team key.
            </small>
          </label>
          <div className="section-row">
            <button
              type="button"
              disabled={busy || !runtimeAvailable}
              onClick={onTestConnection}
            >
              Test connection
            </button>
            {trackerTest ? (
              <small
                className={trackerTest.ok ? "test-result ok" : "test-result err"}
                role="status"
              >
                {trackerTest.message}
              </small>
            ) : null}
          </div>
        </section>

        <section className="settings-section">
          <h3>Agent</h3>
          <label>
            Backend
            <select
              value={settings.agent_backend}
              disabled={!runtimeAvailable}
              onChange={(e) =>
                setSettings({ ...settings, agent_backend: e.currentTarget.value as AppSettings["agent_backend"] })
              }
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
            <small className="hint">
              The CLI that works on issues. Must be installed and authenticated on this machine.
            </small>
          </label>
          {validation ? (
            <small className="hint">
              Codex CLI:{" "}
              <span className={validation.codex_found ? "detect ok" : "detect missing"}>
                {validation.codex_found ? "found" : "not found"}
              </span>
              {" · "}
              Claude CLI:{" "}
              <span className={validation.claude_found ? "detect ok" : "detect missing"}>
                {validation.claude_found ? "found" : "not found"}
              </span>
            </small>
          ) : null}
        </section>
      </div>

      {validation ? (
        <div className={validation.workflow_ok ? "banner ok validation" : "banner error validation"}>
          <strong>{validation.workflow_ok ? "Workflow valid" : "Workflow needs attention"}</strong>
          {validation.workflow_error ? <span>{validation.workflow_error}</span> : null}
        </div>
      ) : null}

      <Panel title="Workflow">
        <textarea
          value={settings.workflow_source}
          disabled={!runtimeAvailable}
          onChange={(e) => setSettings({ ...settings, workflow_source: e.currentTarget.value })}
          spellCheck={false}
        />
      </Panel>

      {validation && runtimeAvailable ? (
        <p className="storage-note">
          Data directory <code>{validation.app_data_dir}</code> · Database{" "}
          <code>{validation.database_path}</code>
        </p>
      ) : null}
    </form>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="inline-link"
      onClick={() => openUrl(href).catch(() => undefined)}
    >
      {children}
    </button>
  );
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
  const visible = events.filter((event) => event.kind !== "humanized");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (!follow) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow]);

  if (visible.length === 0) {
    return (
      <Empty title="No events recorded" text="This run has no agent events yet." />
    );
  }

  return (
    <div
      className="events"
      ref={containerRef}
      onScroll={() => {
        const el = containerRef.current;
        if (!el) return;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      }}
    >
      {visible.map((event) => {
        const { label, summary, tone } = describeEvent(event.kind, event.payload);
        return (
          <article key={event.id} className={tone === "error" ? "event-error" : undefined}>
            <div className="event-line">
              <span className="event-kind">{label}</span>
              <span
                className={
                  event.kind === "tool_call" ? "event-summary mono" : "event-summary"
                }
              >
                {summary || <em>no details</em>}
              </span>
              <time title={shortTime(event.created_at)}>
                {timeOnly(event.created_at)}
              </time>
            </div>
            <details>
              <summary>payload</summary>
              <pre>{prettyPayload(event.payload)}</pre>
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
            <td className="tnum" title={shortTime(run.created_at)}>
              {relativeTime(run.created_at)}
            </td>
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

function StatusItem({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "ok" | "warning";
  title?: string;
}) {
  return (
    <div className={`status-item ${tone ?? ""}`}>
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

function RuntimeBanner({ title, message }: { title: string; message: string }) {
  return (
    <div className="runtime-banner" role="status">
      <div>
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
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

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function label(view: View) {
  return view[0].toUpperCase() + view.slice(1);
}

function friendlyError(message: string) {
  if (
    message.includes("Linear auth failed") ||
    message.includes("Linear HTTP error 401")
  ) {
    return "Linear rejected the request. Add a valid API key under Settings → Linear, then start the worker again.";
  }
  if (
    message.includes("front matter") ||
    message.includes("tracker configuration")
  ) {
    return `The workflow needs attention: ${message}. Edit it under Settings → Workflow.`;
  }
  return message;
}

function formatError(err: unknown) {
  const message = String(err);
  if (message.includes("invoke") || message.includes("transformCallback")) {
    return "Unable to reach the Symphony desktop runtime. Open the Tauri app to use live worker actions.";
  }
  return friendlyError(message);
}

export default App;
