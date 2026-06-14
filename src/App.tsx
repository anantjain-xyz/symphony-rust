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
  RepoConfig,
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
  providerRateLimits,
  providerTokenUsage,
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
  token_usage: [],
};

const previewSettings: AppSettings = {
  prompt_template:
    "# Prompt preview\n\nConnect through the Tauri desktop runtime to load and edit the saved prompt template.",
  repos: [
    {
      name: "widgets",
      url: "git@github.com:acme/widgets.git",
      install_cmd: null,
      team_prefixes: ["ENG"],
      project_ids: [],
      is_default: true,
    },
  ],
  workspace_root: null,
  tracker_workspace: null,
  tracker_prefix: null,
  tracker_project_id: null,
  active_states: ["Todo", "In Progress", "Rework", "Merging"],
  terminal_states: ["Done", "Canceled"],
  polling_interval_ms: 30000,
  max_concurrent_agents: 3,
  max_retry_backoff_ms: 300000,
  hook_after_create:
    'git clone "$REPO_URL" .\ngit checkout -B "${ISSUE_BRANCH:-symphony/${ISSUE_IDENTIFIER}}"\neval "${SYMPHONY_INSTALL_CMD:-npm ci}"\n',
  hook_before_run: null,
  hook_after_run: null,
  hook_before_remove: null,
  hook_timeout_ms: 60000,
  agent_backend: "codex",
  codex_command: null,
  claude_command: null,
  turn_timeout_ms: 3600000,
  codex_approval_policy: "never",
  codex_thread_sandbox: "workspace-write",
  codex_turn_sandbox_policy: "inherit",
  codex_network_access: true,
  claude_permission_mode: "auto",
  claude_allowed_tools: ["Bash(gh *)", "Bash(git status*)", "Bash(curl *)"],
  claude_disallowed_tools: [],
  claude_add_dirs: [],
  linear_api_key_set: false,
};

// Mirrors PROMPT_VARIABLES in symphony-core (crates/symphony-core/src/prompt.rs).
const PROMPT_VARIABLES: { name: string; description: string; example: string }[] = [
  { name: "issue.identifier", description: "Issue key", example: "SYM-42" },
  { name: "issue.title", description: "Issue title", example: "Add user login" },
  { name: "issue.description", description: "Full issue body; empty if none", example: "" },
  { name: "issue.state", description: "Current Linear state", example: "Todo" },
  { name: "issue.branch", description: "Git branch from Linear; may be empty", example: "symphony/SYM-42" },
  { name: "issue.labels", description: "Labels, comma-separated", example: "bug, ui" },
  { name: "issue.blockers", description: "Blocking issues, one bullet per line", example: "- SYM-41" },
  { name: "issue.id", description: "Internal Linear ID", example: "" },
  { name: "repo.name", description: "Name of the repo this issue routed to", example: "widgets" },
  { name: "repo.url", description: "Git URL of the routed repo", example: "git@github.com:org/repo.git" },
];

function anyRepoConfigured(settings: AppSettings): boolean {
  return settings.repos.some((repo) => repo.url.trim() !== "");
}

// Unique trimmed URLs of the configured repos — the key space for per-repo
// skills statuses (two cards with the same URL share one status).
function configuredRepoUrls(settings: AppSettings): string[] {
  return Array.from(
    new Set(settings.repos.map((repo) => repo.url.trim()).filter((url) => url !== "")),
  );
}

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
  const [skillsStatuses, setSkillsStatuses] = useState<Record<string, SkillsStatus>>({});
  const [skillsChecking, setSkillsChecking] = useState<Record<string, boolean>>({});
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
  const skillsCheckSeq = useRef<Record<string, number>>({});

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
      if (!loaded.linear_api_key_set || !anyRepoConfigured(loaded)) return;
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

  // Repo badges and the runs filter only earn their space when runs can
  // actually differ by repo: several repos configured, or history spanning
  // more than one (e.g. after a repo was removed).
  const multiRepo = useMemo(
    () =>
      (settings?.repos.length ?? 0) > 1 ||
      new Set(runs.map((run) => run.repo_name).filter(Boolean)).size > 1,
    [settings, runs],
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
  // busy flag and never blocks the rest of the form. It checks the URL as the
  // user sees it (including unsaved edits), not the saved file. Statuses are
  // keyed by the trimmed URL — a response always describes the URL it was
  // asked about, so out-of-order responses cannot mislabel another repo's
  // status — and a per-URL sequence guards overlapping checks for the SAME
  // repo: only the newest one may apply, or a slow pre-install check could
  // overwrite the post-install refresh that already saw the PR (and a stale
  // failure could delete a good status from the catch path).
  function checkRepoSkills(url: string) {
    const repoUrl = url.trim();
    if (!runtimeAvailable || repoUrl === "") return;
    const seq = (skillsCheckSeq.current[repoUrl] ?? 0) + 1;
    skillsCheckSeq.current[repoUrl] = seq;
    setSkillsChecking((prev) => ({ ...prev, [repoUrl]: true }));
    invoke<SkillsStatus>("get_skills_status", { repoUrl })
      .then((status) => {
        if (skillsCheckSeq.current[repoUrl] !== seq) return;
        setSkillsStatuses((prev) => ({ ...prev, [repoUrl]: status }));
        // A fresh check supersedes a finished install for the same repo —
        // without this, a completed install keeps showing its PR forever.
        setSkillsInstall((prev) =>
          prev?.state !== "running" && prev?.repo_url === repoUrl ? null : prev,
        );
      })
      .catch(() => {
        if (skillsCheckSeq.current[repoUrl] !== seq) return;
        setSkillsStatuses((prev) => {
          const next = { ...prev };
          delete next[repoUrl];
          return next;
        });
      })
      .finally(() => {
        if (skillsCheckSeq.current[repoUrl] !== seq) return;
        setSkillsChecking((prev) => ({ ...prev, [repoUrl]: false }));
      });
  }

  function refreshSkillsStatus(forSettings?: AppSettings) {
    const target = forSettings ?? settings;
    if (!target) return;
    for (const url of configuredRepoUrls(target)) checkRepoSkills(url);
  }

  async function startSkillsInstall(url: string) {
    if (!settings) return;
    const status = await call(() =>
      invoke<SkillsInstallStatus>("install_skills", {
        settings,
        repoUrl: url.trim(),
      }),
    );
    setSkillsInstall(status);
  }

  // Check every configured URL once edits settle (covers the initial settings
  // load, a newly added card, and an edited URL). Debounced so typing doesn't
  // spam gh; URLs that drop out of the config simply leave unused cache keys.
  const repoUrlsKey = settings === null ? null : configuredRepoUrls(settings).join("\n");
  useEffect(() => {
    if (!runtimeAvailable || repoUrlsKey === null || repoUrlsKey === "") return;
    const handle = window.setTimeout(() => {
      for (const url of repoUrlsKey.split("\n")) checkRepoSkills(url);
    }, 600);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoUrlsKey, runtimeAvailable]);

  // While the install session runs, poll its progress; when it lands, re-check
  // its repo so that card's status flips to "PR open" with the link.
  useEffect(() => {
    if (!runtimeAvailable || skillsInstall?.state !== "running") return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      invoke<SkillsInstallStatus>("get_skills_install_status")
        .then((status) => {
          if (cancelled) return;
          setSkillsInstall(status);
          if (status.state === "completed" && status.repo_url) {
            checkRepoSkills(status.repo_url);
          }
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

  async function resetPrompt() {
    if (!settings) return;
    const prompt = await call(() => invoke<string>("get_default_prompt"));
    setSettings({ ...settings, prompt_template: prompt });
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
    (!settings.linear_api_key_set || !anyRepoConfigured(settings));
  // Worst skills state across the configured repos: one repo missing skills
  // keeps the checklist visible, and the step counts as done only when every
  // repo reports installed. Unknown/unavailable repos stay neutral.
  const skillsAggregate = (() => {
    if (settings === null) return null;
    const states = configuredRepoUrls(settings).map((url) => skillsStatuses[url]?.state);
    if (states.some((state) => state === "missing")) return "missing" as const;
    if (states.some((state) => state === "pr_open")) return "pr_open" as const;
    if (states.length > 0 && states.every((state) => state === "installed")) {
      return "installed" as const;
    }
    return null;
  })();
  const setup = {
    blocked: setupBlocked,
    needed:
      setupBlocked || skillsAggregate === "missing" || skillsAggregate === "pr_open",
    linearConnected: settings?.linear_api_key_set ?? false,
    repoConfigured: settings !== null && anyRepoConfigured(settings),
    skillsState: skillsAggregate,
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
            workerRunning={worker.state === "running"}
            setup={setup}
            multiRepo={multiRepo}
            onOpenRun={openRun}
            onStartWorker={startWorker}
            onOpenSettings={() => setView("settings")}
            onOpenIssues={() => setView("issues")}
          />
        ) : null}
        {view === "runs" ? (
          <RunsView
            runs={runs}
            selected={selectedRun}
            activeRunIds={activeRunIds}
            multiRepo={multiRepo}
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
            skillsStatuses={skillsStatuses}
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
            onResetPrompt={resetPrompt}
            onRefreshSkills={checkRepoSkills}
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
  skillsState: "installed" | "pr_open" | "missing" | null;
};

function OverviewView({
  overview,
  canStartWorker,
  workerRunning,
  setup,
  multiRepo,
  onOpenRun,
  onStartWorker,
  onOpenSettings,
  onOpenIssues,
}: {
  overview: Overview;
  canStartWorker: boolean;
  workerRunning: boolean;
  setup: SetupState;
  multiRepo: boolean;
  onOpenRun: (id: string) => void;
  onStartWorker: () => void;
  onOpenSettings: () => void;
  onOpenIssues: () => void;
}) {
  // A run gets a live_sessions row only while it is actively streaming tokens.
  // Use that to pulse streaming rows and show their last-activity heartbeat in
  // the Active runs table (the panel this data used to live in on its own).
  const liveRunIds = new Set(
    overview.live_sessions.map((session) => session.run_id),
  );
  const lastActivity = new Map<string, string>(
    overview.live_sessions.map(
      (session): [string, string] => [session.run_id, session.last_event_at],
    ),
  );
  return (
    <>
      <header className="page-header">
        <div>
          <h2>Overview</h2>
          <p>Local worker state, retries, failures, and provider limits and usage.</p>
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
              setup.blocked
                ? "Open settings"
                : workerRunning
                  ? "View issues"
                  : "Start worker"
            }
            actionDisabled={setup.blocked || workerRunning ? false : !canStartWorker}
            onAction={
              setup.blocked
                ? onOpenSettings
                : workerRunning
                  ? onOpenIssues
                  : onStartWorker
            }
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
                      <small title={shortTime(row.limit.updated_at)}>
                        signal {relativeTime(row.limit.updated_at)}
                      </small>
                    ) : (
                      <small>no limits hit</small>
                    )}
                  </td>
                  <td className="tnum">{row.limit?.remaining ?? "—"}</td>
                  <td
                    className="tnum"
                    title={
                      row.limit?.reset_at
                        ? shortTime(row.limit.reset_at)
                        : undefined
                    }
                  >
                    {row.limit
                      ? row.limit.reset_at
                        ? `resets ${relativeTime(row.limit.reset_at)}`
                        : "no reset reported"
                      : "—"}
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
                      <small title={shortTime(row.usage.updated_at)}>
                        {row.usage.run_count}{" "}
                        {row.usage.run_count === 1 ? "run" : "runs"} · last{" "}
                        {relativeTime(row.usage.updated_at)}
                      </small>
                    ) : (
                      <small>no usage yet</small>
                    )}
                  </td>
                  <td className="tnum">
                    {row.usage ? formatTokens(row.usage.input_tokens) : "—"}
                  </td>
                  <td className="tnum">
                    {row.usage ? formatTokens(row.usage.output_tokens) : "—"}
                  </td>
                  <td className="tnum">
                    {row.usage ? formatTokens(row.usage.total_tokens) : "—"}
                  </td>
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
          title="Add your repositories"
          text="Each run clones the repo its issue routes to into a fresh workspace."
        />
        <SetupStep
          done={setup.skillsState === "installed"}
          step={3}
          title="Install agent skills"
          text={
            setup.skillsState === "pr_open"
              ? "An install PR is open — merge it to finish this step."
              : "Open a PR that adds Symphony's agent skills (workpad, commit, push, …) to each repo. Recommended — agents fall back to plain git and gh without them."
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
  multiRepo,
  onOpenRun,
}: {
  runs: RunWithIssueRow[];
  selected: RunDetail | null;
  activeRunIds: Set<string>;
  multiRepo: boolean;
  onOpenRun: (id: string) => void;
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
                <div className="run-meta-row">
                  <Badge status={selected.run.status} />
                  {selected.run.repo_name ? (
                    <span className="repo-badge">{selected.run.repo_name}</span>
                  ) : null}
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
  skillsStatuses,
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
  onResetPrompt,
  onRefreshSkills,
  onInstallSkills,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  linearKey: string;
  setLinearKey: (value: string) => void;
  validation: ValidationResult | null;
  trackerTest: TrackerTestResult | null;
  skillsStatuses: Record<string, SkillsStatus>;
  skillsChecking: Record<string, boolean>;
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
  onResetPrompt: () => void;
  onRefreshSkills: (repoUrl: string) => void;
  onInstallSkills: (repoUrl: string) => void;
}) {
  const activeStatesEmpty = settings.active_states.every((state) => state.trim() === "");
  const updateRepo = (index: number, patch: Partial<RepoConfig>) =>
    setSettings({
      ...settings,
      repos: settings.repos.map((repo, i) => (i === index ? { ...repo, ...patch } : repo)),
    });
  const addRepo = () =>
    setSettings({
      ...settings,
      repos: [
        ...settings.repos,
        {
          name: "",
          url: "",
          install_cmd: null,
          team_prefixes: [],
          project_ids: [],
          // The first repo is the natural fallback; later ones opt in.
          is_default: settings.repos.length === 0,
        },
      ],
    });
  const removeRepo = (index: number) =>
    setSettings({ ...settings, repos: settings.repos.filter((_, i) => i !== index) });
  const setDefaultRepo = (index: number) =>
    setSettings({
      ...settings,
      repos: settings.repos.map((repo, i) => ({ ...repo, is_default: i === index })),
    });
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
          <p>Linear connection, repository, agent backend, and the prompt that drives runs.</p>
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
          <h3>Repositories</h3>
          <small className="hint">
            Each issue routes to one repo: a <code>repo:&lt;name&gt;</code> label in
            Linear wins, then the repo claiming the issue's project, then its team,
            then the default.
          </small>
          {settings.repos.map((repo, index) => (
            <fieldset className="repo-card" key={index}>
              <div className="repo-card-head">
                <strong>{repo.name.trim() || `Repository ${index + 1}`}</strong>
                <div className="repo-card-actions">
                  <label className="repo-default">
                    <input
                      type="radio"
                      name="default-repo"
                      checked={repo.is_default}
                      disabled={!runtimeAvailable}
                      onChange={() => setDefaultRepo(index)}
                    />
                    Default
                  </label>
                  <button
                    type="button"
                    className="link-button"
                    disabled={!runtimeAvailable}
                    onClick={() => removeRepo(index)}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <label>
                Name
                <input
                  value={repo.name}
                  disabled={!runtimeAvailable}
                  autoComplete="off"
                  onChange={(e) => updateRepo(index, { name: e.currentTarget.value })}
                  placeholder="widgets"
                />
                <small className="hint">
                  Label an issue <code>repo:{repo.name.trim() || "<name>"}</code> in Linear
                  to send it here.
                </small>
              </label>
              <label>
                Repo URL
                <input
                  value={repo.url}
                  disabled={!runtimeAvailable}
                  autoComplete="off"
                  onChange={(e) => updateRepo(index, { url: e.currentTarget.value })}
                  placeholder="git@github.com:org/repo.git"
                />
                <small className="hint">
                  SSH or HTTPS Git URL. Each run clones it into a fresh workspace.
                </small>
              </label>
              <label>
                Install command
                <input
                  value={repo.install_cmd ?? ""}
                  disabled={!runtimeAvailable}
                  autoComplete="off"
                  onChange={(e) =>
                    updateRepo(index, { install_cmd: nullable(e.currentTarget.value) })
                  }
                  placeholder="npm ci"
                />
                <small className="hint">
                  Runs in the workspace after cloning. Leave blank for <code>npm ci</code>.
                </small>
              </label>
              <label>
                Linear teams
                <ListInput
                  value={repo.team_prefixes}
                  disabled={!runtimeAvailable}
                  separator="comma"
                  placeholder="ENG, WAL"
                  onChange={(next) => updateRepo(index, { team_prefixes: next })}
                />
                <small className="hint">
                  Optional. Issues from these team keys land here unless a label or
                  project rule says otherwise.
                </small>
              </label>
              <label>
                Linear projects
                <ListInput
                  value={repo.project_ids}
                  disabled={!runtimeAvailable}
                  separator="comma"
                  placeholder="Project IDs"
                  onChange={(next) => updateRepo(index, { project_ids: next })}
                />
                <small className="hint">
                  Optional. Issues in these projects land here; beats the team rule.
                </small>
              </label>
              <SkillsBlock
                status={skillsStatuses[repo.url.trim()] ?? null}
                checking={skillsChecking[repo.url.trim()] ?? false}
                install={
                  skillsInstall?.repo_url === repo.url.trim() ? skillsInstall : null
                }
                installRunning={skillsInstall?.state === "running"}
                busy={busy}
                runtimeAvailable={runtimeAvailable}
                repoConfigured={repo.url.trim() !== ""}
                onRefresh={() => onRefreshSkills(repo.url)}
                onInstall={() => onInstallSkills(repo.url)}
              />
            </fieldset>
          ))}
          <button
            type="button"
            className="self-start"
            disabled={!runtimeAvailable}
            onClick={addRepo}
          >
            Add repository
          </button>
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
              Where per-run workspaces are created (one folder per repo, then per
              issue). Leave blank to use the app data directory.
            </small>
          </label>
          <small className="hint">
            Agent skills are procedural guides (workpad, commit, push, …) that
            Symphony agents follow. Each card above shows whether its repo has
            them; installing starts an agent session that opens a PR adding them
            under <code>.agents/skills/</code>, with validation commands adapted
            to that repo's toolchain.
          </small>
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
              className="link-button outlined self-start"
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
          <label>
            Active states
            <ListInput
              value={settings.active_states}
              disabled={!runtimeAvailable}
              separator="comma"
              placeholder="Todo, In Progress, Rework, Merging"
              onChange={(next) => setSettings({ ...settings, active_states: next })}
            />
            <small className="hint">
              Comma-separated Linear states the worker picks issues up from.
            </small>
            {activeStatesEmpty ? (
              <small className="test-result err">
                Required — without at least one state the worker never runs.
              </small>
            ) : null}
          </label>
          <label>
            Terminal states
            <ListInput
              value={settings.terminal_states}
              disabled={!runtimeAvailable}
              separator="comma"
              placeholder="Done, Canceled"
              onChange={(next) => setSettings({ ...settings, terminal_states: next })}
            />
            <small className="hint">
              States that mean an issue is finished; its workspace can be cleaned up.
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
          {/* Not a <label>: label activation would forward option clicks back
              to the trigger button and reopen the popup right after selecting. */}
          <div className="field-group">
            Backend
            <BackendSelect
              value={settings.agent_backend}
              disabled={!runtimeAvailable}
              onChange={(backend) => setSettings({ ...settings, agent_backend: backend })}
            />
            <small className="hint">
              The CLI that works on issues. Must be installed and authenticated on this machine.
            </small>
          </div>
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
          <label>
            Turn timeout (seconds)
            <input
              type="number"
              min={1}
              step="any"
              value={settings.turn_timeout_ms / 1000}
              disabled={!runtimeAvailable}
              onChange={(e) => {
                const n = e.currentTarget.valueAsNumber;
                if (Number.isFinite(n) && n >= 0)
                  setSettings({ ...settings, turn_timeout_ms: Math.round(n * 1000) });
              }}
            />
            <small className="hint">
              Max time for one agent turn. 3600 = 1 hour.
            </small>
          </label>
          {settings.agent_backend === "codex" ? (
            <>
              <label>
                Approval policy
                <select
                  value={settings.codex_approval_policy}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      codex_approval_policy: e.currentTarget
                        .value as AppSettings["codex_approval_policy"],
                    })
                  }
                >
                  <option value="never">Never (unattended)</option>
                  <option value="on-request">On request</option>
                  <option value="on-failure">On failure</option>
                  <option value="always">Always</option>
                </select>
                <small className="hint">
                  When Codex pauses for approval. Runs are unattended — keep <code>Never</code>.
                </small>
              </label>
              <label>
                Thread sandbox
                <select
                  value={settings.codex_thread_sandbox}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      codex_thread_sandbox: e.currentTarget
                        .value as AppSettings["codex_thread_sandbox"],
                    })
                  }
                >
                  <option value="workspace-write">Workspace write</option>
                  <option value="read-only">Read only</option>
                  <option value="none">None</option>
                </select>
              </label>
              <label>
                Turn sandbox policy
                <select
                  value={settings.codex_turn_sandbox_policy}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      codex_turn_sandbox_policy: e.currentTarget
                        .value as AppSettings["codex_turn_sandbox_policy"],
                    })
                  }
                >
                  <option value="inherit">Inherit</option>
                  <option value="workspace-write">Workspace write</option>
                  <option value="read-only">Read only</option>
                  <option value="danger-full-access">Danger: full access</option>
                </select>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.codex_network_access}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({ ...settings, codex_network_access: e.currentTarget.checked })
                  }
                />
                Network access
                <small className="hint">
                  Runs push branches and call GitHub/Linear — keep this on.
                </small>
              </label>
            </>
          ) : (
            <>
              <label>
                Permission mode
                <select
                  value={settings.claude_permission_mode}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      claude_permission_mode: e.currentTarget
                        .value as AppSettings["claude_permission_mode"],
                    })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="acceptEdits">Accept edits</option>
                  <option value="default">Default</option>
                  <option value="dontAsk">Don't ask</option>
                  <option value="bypassPermissions">Bypass permissions</option>
                  <option value="plan">Plan</option>
                </select>
                <small className="hint">
                  How Claude Code handles tool permissions during unattended runs.
                </small>
              </label>
              <label>
                Allowed tools
                <ListInput
                  value={settings.claude_allowed_tools}
                  disabled={!runtimeAvailable}
                  separator="newline"
                  rows={8}
                  placeholder={"Bash(gh *)\nBash(git status*)"}
                  onChange={(next) => setSettings({ ...settings, claude_allowed_tools: next })}
                />
                <small className="hint">
                  One rule per line. The target repo's <code>.claude/settings.json</code> can add
                  repo-specific extras on top.
                </small>
              </label>
              <label>
                Disallowed tools
                <ListInput
                  value={settings.claude_disallowed_tools}
                  disabled={!runtimeAvailable}
                  separator="newline"
                  rows={3}
                  onChange={(next) => setSettings({ ...settings, claude_disallowed_tools: next })}
                />
                <small className="hint">One rule per line. Takes precedence over allowed tools.</small>
              </label>
              <label>
                Additional directories
                <ListInput
                  value={settings.claude_add_dirs}
                  disabled={!runtimeAvailable}
                  separator="newline"
                  rows={2}
                  onChange={(next) => setSettings({ ...settings, claude_add_dirs: next })}
                />
                <small className="hint">
                  One path per line, made available to the agent beyond the workspace.
                </small>
              </label>
            </>
          )}
        </section>

        <section className="settings-section">
          <h3>Worker</h3>
          <label>
            Polling interval (seconds)
            <input
              type="number"
              min={1}
              step="any"
              value={settings.polling_interval_ms / 1000}
              disabled={!runtimeAvailable}
              onChange={(e) => {
                const n = e.currentTarget.valueAsNumber;
                if (Number.isFinite(n) && n >= 0)
                  setSettings({ ...settings, polling_interval_ms: Math.round(n * 1000) });
              }}
            />
            <small className="hint">How often Linear is polled for issues.</small>
          </label>
          <label>
            Max concurrent agents
            <input
              type="number"
              min={1}
              value={settings.max_concurrent_agents}
              disabled={!runtimeAvailable}
              onChange={(e) => {
                const n = e.currentTarget.valueAsNumber;
                if (Number.isFinite(n) && n >= 1)
                  setSettings({ ...settings, max_concurrent_agents: Math.trunc(n) });
              }}
            />
            <small className="hint">Issues worked on in parallel.</small>
          </label>
          <label>
            Max retry backoff (seconds)
            <input
              type="number"
              min={0}
              step="any"
              value={settings.max_retry_backoff_ms / 1000}
              disabled={!runtimeAvailable}
              onChange={(e) => {
                const n = e.currentTarget.valueAsNumber;
                if (Number.isFinite(n) && n >= 0)
                  setSettings({ ...settings, max_retry_backoff_ms: Math.round(n * 1000) });
              }}
            />
            <small className="hint">
              Cap on the delay between retries of a failed run. 300 = 5 min.
            </small>
          </label>
          <label>
            Hook timeout (seconds)
            <input
              type="number"
              min={1}
              step="any"
              value={settings.hook_timeout_ms / 1000}
              disabled={!runtimeAvailable}
              onChange={(e) => {
                const n = e.currentTarget.valueAsNumber;
                if (Number.isFinite(n) && n >= 0)
                  setSettings({ ...settings, hook_timeout_ms: Math.round(n * 1000) });
              }}
            />
            <small className="hint">Max time for each hook script.</small>
          </label>
          <details className="hooks-details">
            <summary>Hooks (advanced)</summary>
            <small className="hint">
              Shell scripts run at workspace lifecycle points. They receive{" "}
              <code>$REPO_URL</code>, <code>$ISSUE_IDENTIFIER</code>, <code>$ISSUE_BRANCH</code>,{" "}
              <code>$SYMPHONY_INSTALL_CMD</code>, and the hook name as{" "}
              <code>$SYMPHONY_HOOK</code>.
            </small>
            <label>
              After create
              <textarea
                className="mono-input"
                rows={4}
                value={settings.hook_after_create ?? ""}
                disabled={!runtimeAvailable}
                spellCheck={false}
                onChange={(e) =>
                  setSettings({ ...settings, hook_after_create: nullable(e.currentTarget.value) })
                }
              />
              <small className="hint">
                Runs once per fresh workspace — clone, branch, install.
              </small>
            </label>
            <label>
              Before run
              <textarea
                className="mono-input"
                rows={2}
                value={settings.hook_before_run ?? ""}
                disabled={!runtimeAvailable}
                spellCheck={false}
                onChange={(e) =>
                  setSettings({ ...settings, hook_before_run: nullable(e.currentTarget.value) })
                }
              />
            </label>
            <label>
              After run
              <textarea
                className="mono-input"
                rows={2}
                value={settings.hook_after_run ?? ""}
                disabled={!runtimeAvailable}
                spellCheck={false}
                onChange={(e) =>
                  setSettings({ ...settings, hook_after_run: nullable(e.currentTarget.value) })
                }
              />
            </label>
            <label>
              Before remove
              <textarea
                className="mono-input"
                rows={2}
                value={settings.hook_before_remove ?? ""}
                disabled={!runtimeAvailable}
                spellCheck={false}
                onChange={(e) =>
                  setSettings({ ...settings, hook_before_remove: nullable(e.currentTarget.value) })
                }
              />
            </label>
          </details>
        </section>
      </div>

      {validation ? (
        <div className={validation.workflow_ok ? "banner ok validation" : "banner error validation"}>
          <strong>{validation.workflow_ok ? "Settings valid" : "Settings need attention"}</strong>
          {validation.workflow_error ? <span>{validation.workflow_error}</span> : null}
        </div>
      ) : null}

      <Panel title="Prompt template">
        <PromptEditor
          value={settings.prompt_template}
          disabled={!runtimeAvailable}
          onChange={(next) => setSettings({ ...settings, prompt_template: next })}
        />
        <div className="section-row">
          <button
            type="button"
            disabled={busy || !runtimeAvailable}
            onClick={onResetPrompt}
          >
            Reset to default
          </button>
          <small className="hint">
            Replaces the editor with the bundled default prompt. Nothing changes until you save.
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

// List fields keep a local text draft: round-tripping every keystroke through
// join(parse(...)) would eat separators as the user types them.
function ListInput({
  value,
  onChange,
  disabled,
  separator,
  placeholder,
  rows,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  separator: "comma" | "newline";
  placeholder?: string;
  rows?: number;
}) {
  const join = (items: string[]) =>
    separator === "comma" ? items.join(", ") : items.join("\n");
  const parse = (text: string) =>
    text
      .split(separator === "comma" ? "," : "\n")
      .map((item) => item.trim())
      .filter(Boolean);
  const joined = join(value);
  const [draft, setDraft] = useState(joined);
  const lastEmitted = useRef(joined);
  useEffect(() => {
    // Re-seed only on external changes (settings load, reset to defaults).
    if (joined !== lastEmitted.current) {
      setDraft(joined);
      lastEmitted.current = joined;
    }
  }, [joined]);
  function handleChange(text: string) {
    setDraft(text);
    const next = parse(text);
    lastEmitted.current = join(next);
    onChange(next);
  }
  if (separator === "newline") {
    return (
      <textarea
        className="mono-input"
        value={draft}
        disabled={disabled}
        rows={rows ?? 6}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.currentTarget.value)}
      />
    );
  }
  return (
    <input
      value={draft}
      disabled={disabled}
      autoComplete="off"
      placeholder={placeholder}
      onChange={(e) => handleChange(e.currentTarget.value)}
    />
  );
}

const BACKEND_OPTIONS: Array<{ value: AppSettings["agent_backend"]; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
];

function BackendIcon({ backend }: { backend: AppSettings["agent_backend"] }) {
  if (backend === "claude") {
    return (
      <svg className="backend-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#D97757"
          d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.583.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.473.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        />
      </svg>
    );
  }
  return (
    <svg className="backend-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"
      />
    </svg>
  );
}

// Native <option> elements can't render icons, so the backend picker is a
// custom trigger + listbox driven with the aria-activedescendant pattern.
function BackendSelect({
  value,
  disabled,
  onChange,
}: {
  value: AppSettings["agent_backend"];
  disabled: boolean;
  onChange: (next: AppSettings["agent_backend"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const selected = BACKEND_OPTIONS.find((option) => option.value === value) ?? BACKEND_OPTIONS[0];

  function openList() {
    setActiveIndex(Math.max(0, BACKEND_OPTIONS.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function commit(index: number) {
    onChange(BACKEND_OPTIONS[index].value);
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
      setActiveIndex((index) => Math.min(BACKEND_OPTIONS.length - 1, index + 1));
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
    <div className="icon-select" ref={rootRef}>
      <button
        type="button"
        className="icon-select-trigger"
        disabled={disabled}
        role="combobox"
        aria-label="Backend"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? "backend-listbox" : undefined}
        aria-activedescendant={open ? `backend-option-${BACKEND_OPTIONS[activeIndex].value}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleKeyDown}
      >
        <BackendIcon backend={selected.value} />
        {selected.label}
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
        <ul className="icon-select-list" id="backend-listbox" role="listbox">
          {BACKEND_OPTIONS.map((option, index) => (
            <li
              key={option.value}
              id={`backend-option-${option.value}`}
              role="option"
              aria-selected={option.value === value}
              className={index === activeIndex ? "icon-select-option active" : "icon-select-option"}
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
              <BackendIcon backend={option.value} />
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PromptEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function insertVariable(name: string) {
    const token = `{{${name}}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="prompt-editor">
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <aside className="var-reference">
        <h4>Variables</h4>
        <p className="hint">
          Filled in from the Linear issue when a run starts. Click to insert at the cursor.
        </p>
        <ul className="var-list">
          {PROMPT_VARIABLES.map((variable) => (
            <li key={variable.name}>
              <button
                type="button"
                className="var-button"
                disabled={disabled}
                onClick={() => insertVariable(variable.name)}
              >
                <code>{`{{${variable.name}}}`}</code>
                <small className="hint">
                  {variable.description}
                  {variable.example ? (
                    <>
                      {" — e.g. "}
                      <code>{variable.example}</code>
                    </>
                  ) : null}
                </small>
              </button>
            </li>
          ))}
        </ul>
        <p className="hint">
          On retries, Symphony appends a <code>## Retry context</code> section with the prior
          run's error automatically.
        </p>
      </aside>
    </div>
  );
}

function SkillsBlock({
  status,
  checking,
  install,
  installRunning,
  busy,
  runtimeAvailable,
  repoConfigured,
  onRefresh,
  onInstall,
}: {
  /// Status and install are this card's repo only; installRunning is true
  /// while ANY repo's install session runs (the installer is one-at-a-time).
  status: SkillsStatus | null;
  checking: boolean;
  install: SkillsInstallStatus | null;
  installRunning: boolean;
  busy: boolean;
  runtimeAvailable: boolean;
  repoConfigured: boolean;
  onRefresh: () => void;
  onInstall: () => void;
}) {
  const installing = install?.state === "running";
  const actionsDisabled = busy || installRunning || !runtimeAvailable || !repoConfigured;
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
    detail = "Add this repo's URL first.";
  } else {
    detail = status?.detail ?? "Status not checked yet.";
    action = (
      <button type="button" disabled={actionsDisabled} onClick={onRefresh}>
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

function countMatches(text: string, needle: string) {
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function highlightMatches(
  text: string,
  needle: string,
  firstIndex: number,
  currentIndex: number,
): React.ReactNode {
  if (!needle) return text;
  const haystack = text.toLowerCase();
  let at = haystack.indexOf(needle);
  if (at === -1) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIndex = firstIndex;
  while (at !== -1) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark
        key={matchIndex}
        data-match-index={matchIndex}
        className={matchIndex === currentIndex ? "search-hit current" : "search-hit"}
      >
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    matchIndex += 1;
    cursor = at + needle.length;
    at = haystack.indexOf(needle, cursor);
  }
  parts.push(text.slice(cursor));
  return parts;
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
      totalMatches += countMatches(item.summary, needle);
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
                <span
                  className={
                    event.kind === "tool_call" ? "event-summary mono" : "event-summary"
                  }
                >
                  {summary ? (
                    highlightMatches(summary, needle, starts.summary, current)
                  ) : (
                    <em>no details</em>
                  )}
                </span>
                <time title={shortTime(event.created_at)}>
                  {timeOnly(event.created_at)}
                </time>
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
            <td className="tnum" title={shortTime(run.created_at)}>
              {relativeTime(run.created_at)}
            </td>
            {lastActivity ? (
              <td
                className="tnum"
                title={
                  lastActivity.has(run.id)
                    ? shortTime(lastActivity.get(run.id)!)
                    : undefined
                }
              >
                {lastActivity.has(run.id)
                  ? relativeTime(lastActivity.get(run.id)!)
                  : "—"}
              </td>
            ) : null}
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
