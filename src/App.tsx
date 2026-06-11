import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentEventRow,
  AppSettings,
  IssueRow,
  Overview,
  RunDetail,
  RunWithIssueRow,
  SkillsInstallStatus,
  SkillsStatus,
  TrackerTestResult,
  ValidationResult,
  WorkerStatus,
} from "./bindings";
import {
  describeEvent,
  formatTokens,
  nullable,
  parseSessionInfo,
  prettyPayload,
  priorityLabel,
  relativeTime,
  shortTime,
  statusSlug,
  timeOnly,
} from "./format";
import "./App.css";

type View = "overview" | "runs" | "issues" | "settings";
type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "symphony-theme";
const GITHUB_URL = "https://github.com/anantjain-xyz/symphony-rust";

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
  codex_command: null,
  claude_command: null,
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
  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [skillsChecking, setSkillsChecking] = useState(false);
  const [skillsInstall, setSkillsInstall] = useState<SkillsInstallStatus | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmStopTimer = useRef<number | null>(null);
  const savedFlashTimer = useRef<number | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!runtimeAvailable) return;
    getVersion().then(setAppVersion).catch(() => undefined);
  }, [runtimeAvailable]);

  const selectedRunIdRef = useRef<string | null>(null);
  const autoStartDone = useRef(false);
  const skillsCheckSeq = useRef(0);

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

    const boot = async () => {
      const loaded = await invoke<AppSettings>("load_settings");
      setSettings(loaded);
      setSavedSnapshot(formSnapshot(loaded));
      await refreshDashboard();
      // The worker should be running whenever the app is open, so start it
      // on launch once setup is complete; the topbar toggle stops it.
      if (autoStartDone.current) return;
      autoStartDone.current = true;
      if (!loaded.linear_api_key_set || loaded.repo_url.trim() === "") return;
      const status = await invoke<WorkerStatus>("get_worker_status");
      if (status.state !== "stopped" || status.last_error) return;
      setWorker(await invoke<WorkerStatus>("start_worker"));
    };
    boot().catch((err) => setError(formatError(err)));

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
    refreshSkillsStatus(saved);
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

  // Skill detection talks to GitHub via `gh`, so it runs outside the global
  // busy flag and never blocks the rest of the form. It checks the settings
  // as the user sees them (including unsaved edits), not the saved file.
  function refreshSkillsStatus(forSettings?: AppSettings) {
    const target = forSettings ?? settings;
    if (!runtimeAvailable || !target) return;
    // Overlapping checks (the auto-check on entering Settings plus a manual
    // re-check after editing the repo URL) can resolve out of order; only the
    // newest request may apply, or a slow response for the old repo would
    // overwrite the status of the current one.
    const seq = ++skillsCheckSeq.current;
    setSkillsChecking(true);
    invoke<SkillsStatus>("get_skills_status", { settings: target })
      .then((status) => {
        if (seq !== skillsCheckSeq.current) return;
        setSkillsStatus(status);
        // A fresh check supersedes any finished install — without this, a
        // completed install for repo A keeps showing its PR after the user
        // switches the form to repo B.
        setSkillsInstall((prev) => (prev?.state === "running" ? prev : null));
      })
      .catch(() => {
        if (seq === skillsCheckSeq.current) setSkillsStatus(null);
      })
      .finally(() => {
        if (seq === skillsCheckSeq.current) setSkillsChecking(false);
      });
  }

  async function startSkillsInstall() {
    if (!settings) return;
    const status = await call(() =>
      invoke<SkillsInstallStatus>("install_skills", { settings }),
    );
    setSkillsInstall(status);
  }

  // Invalidate and re-check whenever the repo URL itself changes (including
  // the initial settings load): a status fetched for the previous repo must
  // never drive the install UI. Debounced so typing doesn't spam gh.
  const repoUrl = settings === null ? null : settings.repo_url.trim();
  useEffect(() => {
    if (!runtimeAvailable || repoUrl === null) return;
    // Retire any in-flight check up front — its response is for the previous
    // URL and must not repopulate the status cleared below while the
    // debounced re-check (or nothing, for an empty URL) is pending.
    skillsCheckSeq.current += 1;
    setSkillsChecking(false);
    setSkillsStatus(null);
    setSkillsInstall((prev) => (prev?.state === "running" ? prev : null));
    if (repoUrl === "") return;
    const handle = window.setTimeout(() => refreshSkillsStatus(), 600);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoUrl, runtimeAvailable]);

  // While the install session runs, poll its progress; when it lands, re-check
  // the repo so the status flips to "PR open" with the link.
  useEffect(() => {
    if (!runtimeAvailable || skillsInstall?.state !== "running") return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      invoke<SkillsInstallStatus>("get_skills_install_status")
        .then((status) => {
          if (cancelled) return;
          setSkillsInstall(status);
          if (status.state === "completed") refreshSkillsStatus();
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeAvailable, skillsInstall?.state]);

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

  async function resetWorkflow() {
    if (!settings) return;
    const source = await call(() => invoke<string>("get_default_workflow"));
    setSettings({ ...settings, workflow_source: source });
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

  // `blocked` covers the hard requirements without which runs cannot work;
  // it gates the worker-start affordances and matches the boot auto-start
  // condition. Skills are recommended only: when we positively know they are
  // not installed they keep the checklist visible (`needed`) but never block
  // the worker — and unknown/unavailable must not nag users we can't check.
  const setupBlocked =
    settings !== null &&
    (!settings.linear_api_key_set || settings.repo_url.trim() === "");
  const setup = {
    blocked: setupBlocked,
    needed:
      setupBlocked ||
      (settings !== null &&
        (skillsStatus?.state === "missing" || skillsStatus?.state === "pr_open")),
    linearConnected: settings?.linear_api_key_set ?? false,
    repoConfigured: (settings?.repo_url.trim() ?? "") !== "",
    skills: skillsStatus,
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
    refreshSkillsStatus();
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

  const workerTitle =
    worker.state === "running"
      ? confirmStop
        ? `${overview.active_runs.length} active ${overview.active_runs.length === 1 ? "run" : "runs"} will be interrupted — click again to stop`
        : worker.started_at
          ? `Running since ${shortTime(worker.started_at)} — click to stop`
          : "Stop worker"
      : worker.state === "stopping"
        ? "Worker is stopping"
        : "Start worker";

  return (
    <main className="app">
      <header className="topbar">
        <div className="topbar-primary">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <WaveMark />
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
          <button
            type="button"
            className={`worker-toggle ${worker.state}${confirmStop ? " confirm" : ""}`}
            disabled={busy || !runtimeAvailable || worker.state === "stopping"}
            onClick={worker.state === "running" ? requestStop : startWorker}
            title={workerTitle}
            aria-label={workerTitle}
            aria-live="polite"
          >
            <span className={`status-dot ${worker.state}`} aria-hidden="true" />
            {worker.state === "running" && !confirmStop ? (
              <>
                <span className="worker-toggle-label rest">Running</span>
                <span className="worker-toggle-label on-hover">Stop</span>
              </>
            ) : (
              <span className="worker-toggle-label">
                {worker.state === "running"
                  ? `Stop ${overview.active_runs.length} ${overview.active_runs.length === 1 ? "run" : "runs"}?`
                  : worker.state === "stopping"
                    ? "Stopping…"
                    : "Start"}
              </span>
            )}
          </button>
        </div>
      </header>

      <section
        className={view === "runs" ? "content content-viewport" : "content"}
      >
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
            skillsStatus={skillsStatus}
            skillsChecking={skillsChecking}
            skillsInstall={skillsInstall}
            dirty={dirty}
            savedFlash={savedFlash}
            busy={busy}
            runtimeAvailable={runtimeAvailable}
            appVersion={appVersion}
            onSave={saveSettings}
            onValidate={validate}
            onTestConnection={testConnection}
            onRemoveKey={removeLinearKey}
            onResetWorkflow={resetWorkflow}
            onRefreshSkills={refreshSkillsStatus}
            onInstallSkills={startSkillsInstall}
          />
        ) : null}
      </section>
    </main>
  );
}

type SetupState = {
  blocked: boolean;
  needed: boolean;
  linearConnected: boolean;
  repoConfigured: boolean;
  skills: SkillsStatus | null;
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

      {overview.live_sessions.length > 0 ? (
        <div className="grid">
          <Panel title="Live sessions">
            <table>
              <thead>
                <tr>
                  <th>Issue</th>
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
              setup.blocked
                ? "Finish setup before starting the worker."
                : "Start the worker when you are ready to dispatch agent work."
            }
            actionLabel={setup.blocked ? "Open settings" : "Start worker"}
            actionDisabled={setup.blocked ? false : !canStartWorker}
            onAction={setup.blocked ? onOpenSettings : onStartWorker}
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
            runs={overview.recent_failures.slice(0, 5)}
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
          {setup.blocked
            ? "Symphony watches your Linear project and dispatches Codex or Claude agents to work on issues in isolated workspaces. Finish setup to start the worker."
            : "Symphony is ready to run. One recommended step remains: install the agent skills so dispatched agents follow proven procedures in your repo."}
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
          done={setup.skills?.state === "installed"}
          step={3}
          title="Install agent skills"
          text={
            setup.skills?.state === "pr_open"
              ? "An install PR is open on your repository — merge it to finish this step."
              : "Open a PR that adds Symphony's agent skills (workpad, commit, push, …) to your repo. Recommended — agents fall back to plain git and gh without them."
          }
        />
        <SetupStep
          done={false}
          step={4}
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
          <div className="panel-scroll">
            <RunTable
              runs={runs}
              onOpenRun={onOpenRun}
              emptyTitle="No runs yet"
              emptyText="Runs will appear after the worker dispatches the first issue."
              activeRunIds={activeRunIds}
              selectedRunId={selected?.run.id}
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
                        Open in Linear ↗
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
  skillsStatus,
  skillsChecking,
  skillsInstall,
  dirty,
  savedFlash,
  busy,
  runtimeAvailable,
  appVersion,
  onSave,
  onValidate,
  onTestConnection,
  onRemoveKey,
  onResetWorkflow,
  onRefreshSkills,
  onInstallSkills,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  linearKey: string;
  setLinearKey: (value: string) => void;
  validation: ValidationResult | null;
  trackerTest: TrackerTestResult | null;
  skillsStatus: SkillsStatus | null;
  skillsChecking: boolean;
  skillsInstall: SkillsInstallStatus | null;
  dirty: boolean;
  savedFlash: boolean;
  busy: boolean;
  runtimeAvailable: boolean;
  appVersion: string | null;
  onSave: () => void;
  onValidate: () => void;
  onTestConnection: () => void;
  onRemoveKey: () => void;
  onResetWorkflow: () => void;
  onRefreshSkills: () => void;
  onInstallSkills: () => void;
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
          <SkillsBlock
            status={skillsStatus}
            checking={skillsChecking}
            install={skillsInstall}
            busy={busy}
            runtimeAvailable={runtimeAvailable}
            repoConfigured={settings.repo_url.trim() !== ""}
            onRefresh={onRefreshSkills}
            onInstall={onInstallSkills}
          />
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
          <label>
            Launch command
            <input
              value={
                (settings.agent_backend === "codex"
                  ? settings.codex_command
                  : settings.claude_command) ?? ""
              }
              disabled={!runtimeAvailable}
              autoComplete="off"
              onChange={(e) => {
                const value = nullable(e.currentTarget.value);
                setSettings(
                  settings.agent_backend === "codex"
                    ? { ...settings, codex_command: value }
                    : { ...settings, claude_command: value },
                );
              }}
              placeholder={settings.agent_backend}
            />
            <small className="hint">
              Optional. How the agent is launched — e.g. a wrapper like{" "}
              <code>mycode --agent {settings.agent_backend}</code>. Leave blank to run{" "}
              <code>{settings.agent_backend}</code> directly.
            </small>
          </label>
          {validation ? (
            <small className="hint">
              Codex CLI
              {validation.codex_command === "codex" ? "" : ` (${validation.codex_command})`}:{" "}
              <span className={validation.codex_found ? "detect ok" : "detect missing"}>
                {validation.codex_found ? "found" : "not found"}
              </span>
              {" · "}
              Claude CLI
              {validation.claude_command === "claude" ? "" : ` (${validation.claude_command})`}:{" "}
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
        <div className="section-row">
          <button
            type="button"
            disabled={busy || !runtimeAvailable}
            onClick={onResetWorkflow}
          >
            Reset to default
          </button>
          <small className="hint">
            Replaces the editor with the bundled default workflow. Nothing changes until you save.
          </small>
        </div>
      </Panel>

      {validation && runtimeAvailable ? (
        <div className="settings-footer">
          <div className="storage-actions">
            <button
              type="button"
              onClick={() =>
                revealItemInDir(validation.database_path).catch(() => undefined)
              }
            >
              Reveal database
            </button>
            <button
              type="button"
              onClick={() =>
                revealItemInDir(`${validation.app_data_dir}/logs`).catch(
                  () => undefined,
                )
              }
            >
              Reveal logs
            </button>
          </div>
          <p className="storage-note">
            Data directory <code>{validation.app_data_dir}</code>
          </p>
        </div>
      ) : null}

      <p className="about-note">
        Symphony{appVersion ? ` v${appVersion}` : ""} ·{" "}
        <ExternalLink href={GITHUB_URL}>GitHub</ExternalLink> ·{" "}
        <ExternalLink href={`${GITHUB_URL}/issues`}>Report an issue</ExternalLink>
      </p>
    </form>
  );
}

function SkillsBlock({
  status,
  checking,
  install,
  busy,
  runtimeAvailable,
  repoConfigured,
  onRefresh,
  onInstall,
}: {
  status: SkillsStatus | null;
  checking: boolean;
  install: SkillsInstallStatus | null;
  busy: boolean;
  runtimeAvailable: boolean;
  repoConfigured: boolean;
  onRefresh: () => void;
  onInstall: () => void;
}) {
  const installing = install?.state === "running";
  const actionsDisabled = busy || !runtimeAvailable || !repoConfigured;
  // A just-finished install knows the PR URL before the next status check does.
  const prUrl =
    (install?.state === "completed" ? install.pr_url : null) ??
    status?.pr_url ??
    null;

  let detail: React.ReactNode;
  let action: React.ReactNode = null;
  if (installing) {
    detail = install?.message ?? "Installing…";
    action = (
      <button type="button" disabled>
        Creating install PR…
      </button>
    );
  } else if (install?.state === "failed") {
    detail = (
      <span className="test-result err">{install.error ?? "Install failed."}</span>
    );
    action = (
      <button type="button" disabled={actionsDisabled} onClick={onInstall}>
        Retry install PR
      </button>
    );
  } else if (checking) {
    detail = "Checking your repository…";
  } else if (status?.state === "installed") {
    detail = (
      <span className="test-result ok">
        Installed — agents will use the skills in this repo.
      </span>
    );
  } else if (prUrl) {
    detail = (
      <span className="test-result ok">Install PR open — merge it to finish.</span>
    );
    action = (
      <button
        type="button"
        className="link-button"
        onClick={() => openUrl(prUrl).catch(() => undefined)}
      >
        View PR ↗
      </button>
    );
  } else if (status?.state === "missing") {
    detail = `Not installed — ${status.missing.length} of 7 skills missing.`;
    action = (
      <button type="button" disabled={actionsDisabled} onClick={onInstall}>
        Create install PR
      </button>
    );
  } else if (!repoConfigured) {
    detail = "Add a repo URL above first.";
  } else {
    detail = status?.detail ?? "Status not checked yet.";
    action = (
      // Zero-arg wrapper: the handler takes optional settings, and React's
      // mouse event must not be mistaken for them.
      <button type="button" disabled={actionsDisabled} onClick={() => onRefresh()}>
        Check
      </button>
    );
  }

  return (
    <div className="field-group">
      Agent skills
      <div className="section-row">
        {action}
        <small className="test-result" role="status">
          {detail}
        </small>
      </div>
      <small className="hint">
        Procedural guides (workpad, commit, push, …) that Symphony agents follow
        in your repo. Installing starts an agent session that opens a PR adding
        them under <code>.agents/skills/</code>, with validation commands
        adapted to your toolchain.
      </small>
    </div>
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

function WaveMark() {
  return (
    <svg
      className="brand-icon"
      viewBox="0 0 100 100"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="36" width="8" height="28" rx="4" />
      <rect x="18" y="25" width="8" height="50" rx="4" />
      <rect x="32" y="12" width="8" height="76" rx="4" />
      <rect x="46" y="28" width="8" height="44" rx="4" />
      <rect x="60" y="4" width="8" height="92" rx="4" />
      <rect x="74" y="20" width="8" height="60" rx="4" />
      <rect x="88" y="34" width="8" height="32" rx="4" />
    </svg>
  );
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
