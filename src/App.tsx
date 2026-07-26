import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject, SetStateAction } from "react";
import type {
  AgentEventRow,
  AppSettings,
  IssueRow,
  LinearViewerProfile,
  Overview,
  RepoWorkflowStatus,
  RetroDetail,
  RetroRow,
  RetroStatus,
  RunDetail,
  RunWithIssueRow,
  SkillsInstallStatus,
  SkillsStatus,
  TrackerTestResult,
  ValidationResult,
  WorkflowTransferStatus,
  WorkerStatus,
} from "./bindings";
import {
  formatTokens,
  providerRateLimits,
  providerTokenUsage,
  shortTime,
  statusSlug,
} from "./format";
import { RelativeTime } from "./RelativeTime";
import {
  createDashboardRefreshCoordinator,
  type DashboardRefreshContext,
  type DashboardRefreshCoordinator,
} from "./dashboardRefreshCoordinator";
import {
  resourcesForDbChange,
  resourcesForView,
  visibleResources,
  type DashboardResourceKey,
} from "./dashboardResources";
import * as desktopCommands from "./desktop/commands";
import { subscribeDesktopEvents } from "./desktop/events";
import { isDesktopRuntime } from "./desktop/runtime";
import {
  beginResourceRefresh,
  completeResourceRefresh,
  createResourceEnvelope,
  failResourceRefresh,
  hasResourceData,
  markResourceDirty as markEnvelopeDirty,
  normalizeResourceError,
  resourceIsStale,
  staleDirtyResource,
  type DashboardResourceEnvelope,
  type DashboardResourceError,
} from "./dashboardResourceState";
import {
  createPollController,
  type PollController,
  type PollResourceState,
} from "./pollController";
import type { SettingsValidationController } from "./settingsValidationController";
import { ChunkErrorBoundary, ViewLoading, createLazyAttempts } from "./ChunkBoundary";
import "./App.css";

type View = "overview" | "runs" | "issues" | "retro" | "settings";
type Theme = "light" | "dark";
type PollKey = "worker" | "retro" | "skillsInstall" | "workflowTransfer";

function cachedImport<T>(importer: () => Promise<T>) {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      promise = importer().catch((error) => {
        promise = null;
        throw error;
      });
    }
    return promise;
  };
}

const loadRunsView = cachedImport(() => import("./views/RunsView"));
const loadIssuesView = cachedImport(() => import("./views/IssuesView"));
const loadRetroView = cachedImport(() => import("./views/RetroView"));
const loadSettingsView = cachedImport(() => import("./views/SettingsView"));
const loadPreviewRuntime = cachedImport(() => import("./preview/runtime"));
type AppUpdateModule = Pick<typeof import("./AppUpdate"), "AppUpdateFeature">;
const loadAppUpdate = (): Promise<AppUpdateModule> => import("./AppUpdate");

const RunsViewAttempts = createLazyAttempts(loadRunsView);
const IssuesViewAttempts = createLazyAttempts(loadIssuesView);
const RetroViewAttempts = createLazyAttempts(loadRetroView);
const SettingsViewAttempts = createLazyAttempts(loadSettingsView);
const loadSettingsHeaderActions = () =>
  loadSettingsView().then(({ SettingsHeaderActions }) => ({
    default: SettingsHeaderActions,
  }));
const SettingsHeaderAttempts = createLazyAttempts(loadSettingsHeaderActions);

export function useDeferredUpdater(
  enabled: boolean,
  loader: () => Promise<AppUpdateModule> = loadAppUpdate,
) {
  const [Component, setComponent] = useState<AppUpdateModule["AppUpdateFeature"] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const requestUpdater = () => {
      idleId = null;
      timeoutId = null;
      void loader()
        .then(({ AppUpdateFeature }) => {
          if (!cancelled) setComponent(() => AppUpdateFeature);
        })
        .catch(() => {
          if (!cancelled) timeoutId = window.setTimeout(requestUpdater, 2_000);
        });
    };
    if ("requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(requestUpdater, { timeout: 2_000 });
    } else {
      timeoutId = globalThis.setTimeout(requestUpdater, 2_000);
    }
    return () => {
      cancelled = true;
      if (idleId !== null) window.cancelIdleCallback(idleId);
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
    };
  }, [enabled, loader]);

  return Component;
}

function preloadView(view: View) {
  const pending =
    view === "runs"
      ? loadRunsView()
      : view === "issues"
        ? loadIssuesView()
        : view === "retro"
          ? loadRetroView()
          : view === "settings"
            ? loadSettingsView()
            : null;
  void pending?.catch(() => undefined);
}
const POLL_LABELS: Record<PollKey, string> = {
  worker: "worker status",
  retro: "Retro progress",
  skillsInstall: "skills installation",
  workflowTransfer: "workflow transfer",
};

const THEME_STORAGE_KEY = "symphony-theme";
const IS_LOCAL_DEV = import.meta.env.DEV;
const DASHBOARD_COMMAND_TRACE_ENABLED = IS_LOCAL_DEV && import.meta.env.MODE !== "test";
const DASHBOARD_RESOURCE_KEYS: readonly DashboardResourceKey[] = [
  "overview",
  "runs",
  "issues",
  "worker",
  "retroList",
  "retroBatches",
  "selectedRun",
  "selectedRetro",
];

function getInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The root theme still updates when storage is unavailable.
    }
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

const emptyRetroStatus: RetroStatus = {
  state: "idle",
  retro_id: null,
  message: null,
  report: null,
  error: null,
};

function anyRepoConfigured(settings: AppSettings): boolean {
  return settings.repos.some((repo) => repo.url.trim() !== "");
}

type DashboardSnapshot = {
  overview: Overview;
  runs: RunWithIssueRow[];
  issues: IssueRow[];
  worker: WorkerStatus;
  retroStatus: RetroStatus;
  retros: RetroRow[];
  hasInProgressRetroBatches: boolean;
  requestedRunId: string | null;
  selectedRun: RunDetail | null;
  requestedRetroId: string | null;
  selectedRetroId: string | null;
  selectedRetro: RetroDetail | null;
};

type DashboardSnapshotSelection = {
  selectedRunId?: string | null;
  selectedRetroId?: string | null;
};

type RetroListResource = {
  retroStatus: RetroStatus;
  retros: RetroRow[];
};

type DashboardResourceData = {
  overview: Overview;
  runs: RunWithIssueRow[];
  issues: IssueRow[];
  worker: WorkerStatus;
  retroList: RetroListResource;
  retroBatches: boolean;
  selectedRun: RunDetail | null;
  selectedRetro: RetroDetail | null;
};

type DashboardResourceEnvelopes = {
  [Key in DashboardResourceKey]: DashboardResourceEnvelope<DashboardResourceData[Key]>;
};

const RESOURCE_LABELS: Record<DashboardResourceKey, string> = {
  overview: "Overview",
  runs: "Runs",
  issues: "Issues",
  worker: "Worker status",
  retroList: "Retro history",
  retroBatches: "Retro changes",
  selectedRun: "Run details",
  selectedRetro: "Retro details",
};

function createInitialDashboardResources(): DashboardResourceEnvelopes {
  return {
    overview: createResourceEnvelope<Overview>(),
    runs: createResourceEnvelope<RunWithIssueRow[]>(),
    issues: createResourceEnvelope<IssueRow[]>(),
    worker: createResourceEnvelope<WorkerStatus>(),
    retroList: createResourceEnvelope<RetroListResource>(),
    retroBatches: createResourceEnvelope<boolean>(),
    selectedRun: createResourceEnvelope<RunDetail | null>(),
    selectedRetro: createResourceEnvelope<RetroDetail | null>(),
  };
}

export async function loadDashboardSnapshot({
  selectedRunId = null,
  selectedRetroId = null,
}: DashboardSnapshotSelection = {}): Promise<DashboardSnapshot> {
  const [
    overview,
    runs,
    issues,
    worker,
    selectedRun,
    retroStatus,
    retros,
    requestedRetro,
    hasInProgressRetroBatches,
  ] = await Promise.all([
    desktopCommands.getOverview(),
    desktopCommands.listRuns(),
    desktopCommands.listIssues(),
    desktopCommands.getWorkerStatus(),
    selectedRunId ? desktopCommands.getRunDetail(selectedRunId) : Promise.resolve(null),
    desktopCommands.getRetroStatus(),
    desktopCommands.listRetros(),
    selectedRetroId ? desktopCommands.getRetroDetail(selectedRetroId) : Promise.resolve(null),
    desktopCommands.hasInProgressRetroBatches(),
  ]);

  const nextSelectedRetroId = selectedRetroId ?? retros[0]?.id ?? null;
  const selectedRetro = selectedRetroId ? requestedRetro : null;

  return {
    overview,
    runs,
    issues,
    worker,
    retroStatus,
    retros,
    hasInProgressRetroBatches,
    requestedRunId: selectedRunId,
    selectedRun,
    requestedRetroId: selectedRetroId,
    selectedRetroId: nextSelectedRetroId,
    selectedRetro,
  };
}

type BootstrapResult = {
  settings: AppSettings;
  dashboard: DashboardSnapshot;
  autoStart: Promise<WorkerStatus> | null;
};

type BootState =
  | { status: "loading" }
  | { status: "ready"; payload: BootstrapResult }
  | { status: "error"; message: string };

type ResourceFailureAnnouncement = {
  id: number;
  key: DashboardResourceKey;
  role: "status" | "alert";
  message: string;
};

let bootstrapPromise: Promise<BootstrapResult> | null = null;

function loadBootstrap(): Promise<BootstrapResult> {
  if (bootstrapPromise) return bootstrapPromise;

  const pending = (async () => {
    const [settings, dashboard] = await Promise.all([
      desktopCommands.loadSettings(),
      loadDashboardSnapshot(),
    ]);
    const autoStart =
      !settings.linear_api_key_set ||
      !anyRepoConfigured(settings) ||
      dashboard.worker.state !== "stopped" ||
      dashboard.worker.last_error
        ? null
        : desktopCommands.startWorker();
    return { settings, dashboard, autoStart };
  })();
  bootstrapPromise = pending;
  void pending.then(
    ({ autoStart }) => {
      if (!autoStart) {
        if (bootstrapPromise === pending) bootstrapPromise = null;
        return;
      }
      void autoStart.then(
        () => {
          if (bootstrapPromise === pending) bootstrapPromise = null;
        },
        () => {
          if (bootstrapPromise === pending) bootstrapPromise = null;
        },
      );
    },
    () => {
      if (bootstrapPromise === pending) bootstrapPromise = null;
    },
  );
  return pending;
}

function resetBootstrap() {
  bootstrapPromise = null;
}

// Unique trimmed URLs of the configured repos — the key space for per-repo
// skills statuses (two cards with the same URL share one status).
function configuredRepoUrls(settings: AppSettings): string[] {
  return Array.from(
    new Set(settings.repos.map((repo) => repo.url.trim()).filter((url) => url !== "")),
  );
}

function retroRowRenderedFields(row: RetroRow) {
  return {
    id: row.id,
    sinceAt: row.since_at,
    untilAt: row.until_at,
    status: row.status,
    runCount: row.run_count,
    issueCount: row.issue_count,
    error: row.error_message,
    createdAt: row.created_at,
  };
}

function retroDetailRenderedFields(detail: RetroDetail | null | undefined) {
  if (!detail) return null;
  return {
    row: retroRowRenderedFields(detail.row),
    report: detail.report,
    suggestions: detail.suggestions.map((suggestion) => ({
      id: suggestion.id,
      repoName: suggestion.repo_name,
      findingIndex: suggestion.finding_index,
      targetType: suggestion.target_type,
      targetId: suggestion.target_id,
      targetPath: suggestion.target_path,
      title: suggestion.title,
      body: suggestion.body,
      rationale: suggestion.rationale,
      confidence: suggestion.confidence,
      guidance: suggestion.guidance,
      beforeContent: suggestion.before_content,
      afterContent: suggestion.after_content,
      unifiedDiff: suggestion.unified_diff,
      proposalStatus: suggestion.proposal_status,
      proposalError: suggestion.proposal_error,
      decision: suggestion.decision,
      decidedAt: suggestion.decided_at,
    })),
    batches: detail.batches.map((batch) => ({
      id: batch.id,
      repoName: batch.repo_name,
      state: batch.state,
      progress: batch.progress,
      error: batch.error,
      prUrl: batch.pr_url,
    })),
  };
}

function stableSessionEnvKey(env: AppSettings["session_env"]): string {
  return JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)));
}

function skillsCheckContextKey(repoUrl: string, sessionEnv: AppSettings["session_env"]): string {
  return `${repoUrl}\n${stableSessionEnvKey(sessionEnv)}`;
}

// linear_api_key_set is server-derived, not part of the editable form.
function formSnapshot(settings: AppSettings) {
  const { linear_api_key_set: _ignored, ...form } = settings;
  return JSON.stringify(form);
}

function App({ onRender }: { onRender?: () => void } = {}) {
  onRender?.();
  const runtimeAvailable = isDesktopRuntime();
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<View>("overview");
  const [viewAttempts, setViewAttempts] = useState<Record<Exclude<View, "overview">, number>>({
    runs: 0,
    issues: 0,
    retro: 0,
    settings: 0,
  });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const settingsDraftRef = useRef<AppSettings | null>(null);
  const settingsRevisionRef = useRef(0);
  const linearKeyDraftRef = useRef("");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsDirtyRef = useRef(false);
  const [settingsSavePending, setSettingsSavePending] = useState(false);
  const settingsSavePendingRef = useRef(false);
  const settingsSaveControllerRef = useRef<SettingsValidationController | null>(null);
  const [linearViewer, setLinearViewer] = useState<LinearViewerProfile | null>(null);
  const [linearViewerLoading, setLinearViewerLoading] = useState(false);
  const [linearViewerError, setLinearViewerError] = useState<string | null>(null);
  const [dashboardResources, setDashboardResources] = useState<DashboardResourceEnvelopes>(
    createInitialDashboardResources,
  );
  const overview = dashboardResources.overview.data ?? emptyOverview;
  const runs = dashboardResources.runs.data ?? [];
  const issues = dashboardResources.issues.data ?? [];
  const retros = dashboardResources.retroList.data?.retros ?? [];
  const retroStatus = dashboardResources.retroList.data?.retroStatus ?? emptyRetroStatus;
  const worker = dashboardResources.worker.data ?? {
    state: "stopped",
    started_at: null,
    last_error: null,
  };
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const selectedRun = dashboardResources.selectedRun.data ?? null;
  const selectedRetro = dashboardResources.selectedRetro.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [resourceAnnouncement, setResourceAnnouncement] =
    useState<ResourceFailureAnnouncement | null>(null);
  const [slowRefreshingKeys, setSlowRefreshingKeys] = useState<Set<DashboardResourceKey>>(
    () => new Set(),
  );
  const [busy, setBusy] = useState(false);
  const [bootState, setBootState] = useState<BootState>({ status: "loading" });
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrapSettled, setBootstrapSettled] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [savedLiveConfigKept, setSavedLiveConfigKept] = useState(false);
  const [trackerTest, setTrackerTest] = useState<TrackerTestResult | null>(null);
  const [skillsStatuses, setSkillsStatuses] = useState<Record<string, SkillsStatus>>({});
  const [skillsChecking, setSkillsChecking] = useState<Record<string, boolean>>({});
  const [skillsInstall, setSkillsInstall] = useState<SkillsInstallStatus | null>(null);
  const [workflowStatuses, setWorkflowStatuses] = useState<Record<string, RepoWorkflowStatus>>({});
  const [workflowReadinessEpoch, setWorkflowReadinessEpoch] = useState(0);
  const [workflowChecking, setWorkflowChecking] = useState<Record<string, boolean>>({});
  const [workflowTransfer, setWorkflowTransfer] = useState<WorkflowTransferStatus | null>(null);
  const [pollingStates, setPollingStates] = useState<Partial<Record<PollKey, PollResourceState>>>(
    {},
  );
  const hasInProgressRetroBatches = dashboardResources.retroBatches.data ?? false;
  const [stoppingRunIds, setStoppingRunIds] = useState<Set<string>>(() => new Set());
  const [triggeringRetryIds, setTriggeringRetryIds] = useState<Set<string>>(() => new Set());
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmStopTimer = useRef<number | null>(null);
  const savedFlashTimer = useRef<number | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const RunsView = RunsViewAttempts.get(viewAttempts.runs);
  const IssuesView = IssuesViewAttempts.get(viewAttempts.issues);
  const RetroView = RetroViewAttempts.get(viewAttempts.retro);
  const SettingsFeature = SettingsViewAttempts.get(viewAttempts.settings);
  const SettingsHeaderActions = SettingsHeaderAttempts.get(viewAttempts.settings);

  const retryView = (target: Exclude<View, "overview">) => {
    const nextAttempt =
      target === "runs"
        ? RunsViewAttempts.add()
        : target === "issues"
          ? IssuesViewAttempts.add()
          : target === "retro"
            ? RetroViewAttempts.add()
            : SettingsViewAttempts.add();
    if (target === "settings") SettingsHeaderAttempts.add();
    setViewAttempts((current) => ({ ...current, [target]: nextAttempt }));
  };

  const selectedRunIdRef = useRef<string | null>(null);
  const selectedRetroIdRef = useRef<string | null>(null);
  const previewRuntimeRef = useRef<typeof import("./preview/runtime")["previewRuntime"] | null>(
    null,
  );
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  const dirtyResourcesRef = useRef<Set<DashboardResourceKey>>(new Set());
  const dirtyResourceVersionsRef = useRef<Partial<Record<DashboardResourceKey, number>>>({});
  const selectedRunRef = useRef<RunDetail | null>(selectedRun);
  selectedRunRef.current = selectedRun;
  const workflowReadinessDirtyRef = useRef(false);
  const typedAgentEventAwaitingDbChangeRef = useRef(false);
  const localAppendVersionRef = useRef(0);
  const resourceCommandCounts = useRef<Record<string, number>>({});
  const skillsCheckSeq = useRef<Record<string, number>>({});
  const skillsCheckContext = useRef<Record<string, string>>({});
  const skillsInstallSettingsRef = useRef<AppSettings | null>(null);
  const workflowCheckSeq = useRef<Record<string, number>>({});
  const workflowCheckContext = useRef<Record<string, string>>({});
  const repoStatusRefreshTimer = useRef<number | null>(null);
  const queueRepoStatusRefreshRef = useRef<(target: AppSettings) => void>(() => undefined);
  const linearViewerSeq = useRef(0);
  const pollControllers = useRef<Partial<Record<PollKey, PollController>>>({});
  const refreshAffordanceTimers = useRef(new Map<DashboardResourceKey, number>());
  const userRetryKeys = useRef(new Set<DashboardResourceKey>());
  const userFailureAnnouncedKeys = useRef(new Set<DashboardResourceKey>());
  const resourceAnnouncementSequence = useRef(0);
  const dashboardResourcesRef = useRef(dashboardResources);
  dashboardResourcesRef.current = dashboardResources;
  const dashboardResourceValues = useRef(new Map<DashboardResourceKey, unknown>());

  function updateDashboardResource<Key extends DashboardResourceKey>(
    key: Key,
    update: (
      current: DashboardResourceEnvelope<DashboardResourceData[Key]>,
    ) => DashboardResourceEnvelope<DashboardResourceData[Key]>,
  ) {
    const current = dashboardResourcesRef.current[key] as DashboardResourceEnvelope<
      DashboardResourceData[Key]
    >;
    const next = {
      ...dashboardResourcesRef.current,
      [key]: update(current),
    } as DashboardResourceEnvelopes;
    dashboardResourcesRef.current = next;
    setDashboardResources(next);
  }

  function setResourceData<Key extends DashboardResourceKey>(
    key: Key,
    update: SetStateAction<DashboardResourceData[Key]>,
  ) {
    updateDashboardResource(key, (resource) => ({
      ...resource,
      data:
        typeof update === "function"
          ? (update as (current: DashboardResourceData[Key]) => DashboardResourceData[Key])(
              resource.data as DashboardResourceData[Key],
            )
          : update,
    }));
  }

  const setOverview = (update: SetStateAction<Overview>) => setResourceData("overview", update);
  const setRuns = (update: SetStateAction<RunWithIssueRow[]>) => setResourceData("runs", update);
  const setWorker = (update: SetStateAction<WorkerStatus>) => setResourceData("worker", update);
  const setRetroStatus = (update: SetStateAction<RetroStatus>) =>
    setResourceData("retroList", (current) => ({
      ...current,
      retroStatus: typeof update === "function" ? update(current.retroStatus) : update,
    }));
  const setRetros = (update: SetStateAction<RetroRow[]>) =>
    setResourceData("retroList", (current) => ({
      ...current,
      retros: typeof update === "function" ? update(current.retros) : update,
    }));
  const setHasInProgressRetroBatches = (update: SetStateAction<boolean>) =>
    setResourceData("retroBatches", update);
  const setSelectedRun = (update: SetStateAction<RunDetail | null>) =>
    setResourceData("selectedRun", update);
  const setSelectedRetro = (update: SetStateAction<RetroDetail | null>) =>
    setResourceData("selectedRetro", update);

  function commitResourceSuccess<Key extends DashboardResourceKey>(
    key: Key,
    data: DashboardResourceData[Key],
    now = new Date().toISOString(),
  ) {
    dashboardResourceValues.current.set(key, data);
    updateDashboardResource(key, (resource) => completeResourceRefresh(resource, data, now));
    userFailureAnnouncedKeys.current.delete(key);
    setResourceAnnouncement((current) => (current?.key === key ? null : current));
  }

  function resetDashboardResource<Key extends DashboardResourceKey>(key: Key) {
    dashboardResourceValues.current.delete(key);
    updateDashboardResource(key, () => createResourceEnvelope<DashboardResourceData[Key]>());
  }

  function beginDashboardResourceRefresh(key: DashboardResourceKey) {
    updateDashboardResource(key, (resource) =>
      beginResourceRefresh(resource, new Date().toISOString()),
    );
    const priorTimer = refreshAffordanceTimers.current.get(key);
    if (priorTimer !== undefined) window.clearTimeout(priorTimer);
    const timer = window.setTimeout(() => {
      refreshAffordanceTimers.current.delete(key);
      setSlowRefreshingKeys((current) => new Set(current).add(key));
    }, 250);
    refreshAffordanceTimers.current.set(key, timer);
  }

  function finishDashboardResourceRefresh(key: DashboardResourceKey) {
    const timer = refreshAffordanceTimers.current.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    refreshAffordanceTimers.current.delete(key);
    setSlowRefreshingKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function commitResourceFailure(
    key: DashboardResourceKey,
    refreshError: unknown,
    userInitiated: boolean,
  ) {
    const current = dashboardResourcesRef.current[key] as DashboardResourceEnvelope<
      DashboardResourceData[typeof key]
    >;
    const newlySurfaced = current.error === null;
    const normalized = normalizeResourceError(RESOURCE_LABELS[key], refreshError);
    updateDashboardResource(key, (resource) =>
      failResourceRefresh(resource, normalized, new Date().toISOString()),
    );
    const hasData = hasResourceData(current);
    const shouldAnnounce =
      hasData && (newlySurfaced || (userInitiated && !userFailureAnnouncedKeys.current.has(key)));
    if (shouldAnnounce) {
      if (userInitiated) userFailureAnnouncedKeys.current.add(key);
      setResourceAnnouncement({
        id: ++resourceAnnouncementSequence.current,
        key,
        role: userInitiated ? "alert" : "status",
        message: normalized.summary,
      });
    }
  }

  function commitDashboardSnapshot(snapshot: DashboardSnapshot) {
    const now = new Date().toISOString();
    commitResourceSuccess("overview", snapshot.overview, now);
    commitResourceSuccess("runs", snapshot.runs, now);
    commitResourceSuccess("issues", snapshot.issues, now);
    commitResourceSuccess("worker", snapshot.worker, now);
    commitResourceSuccess(
      "retroList",
      {
        retroStatus: snapshot.retroStatus,
        retros: snapshot.retros,
      },
      now,
    );
    commitResourceSuccess("retroBatches", snapshot.hasInProgressRetroBatches, now);
    if (snapshot.requestedRunId && snapshot.requestedRunId === selectedRunIdRef.current) {
      commitResourceSuccess("selectedRun", snapshot.selectedRun, now);
      if (!snapshot.selectedRun) selectedRunIdRef.current = null;
    }
    if (snapshot.requestedRetroId && snapshot.requestedRetroId === selectedRetroIdRef.current) {
      commitResourceSuccess("selectedRetro", snapshot.selectedRetro, now);
      if (!snapshot.selectedRetro) selectedRetroIdRef.current = null;
    } else if (!snapshot.requestedRetroId && selectedRetroIdRef.current === null) {
      selectedRetroIdRef.current = snapshot.selectedRetroId;
      if (snapshot.selectedRetroId !== null && snapshot.selectedRetro === null) {
        resetDashboardResource("selectedRetro");
        markResourceDirty("selectedRetro");
      } else {
        commitResourceSuccess("selectedRetro", snapshot.selectedRetro, now);
      }
    }
  }

  function markResourceDirty(key: DashboardResourceKey) {
    dirtyResourcesRef.current.add(key);
    dirtyResourceVersionsRef.current[key] = (dirtyResourceVersionsRef.current[key] ?? 0) + 1;
    updateDashboardResource(key, (resource) =>
      markEnvelopeDirty(resource, new Date().toISOString()),
    );
  }

  async function loadDashboardResource<T>(
    key: DashboardResourceKey,
    load: () => Promise<T>,
  ): Promise<T> {
    if (DASHBOARD_COMMAND_TRACE_ENABLED) {
      const count = (resourceCommandCounts.current[key] ?? 0) + 1;
      resourceCommandCounts.current[key] = count;
      console.debug("[dashboard-resource] command", { key, count });
    }
    return load();
  }

  const dashboardRefreshExecutor = useRef<
    (context: DashboardRefreshContext<DashboardResourceKey>) => Promise<void>
  >(async () => undefined);
  const dashboardRefreshCoordinator = useRef<
    DashboardRefreshCoordinator<DashboardResourceKey> | undefined
  >(undefined);
  if (!dashboardRefreshCoordinator.current) {
    dashboardRefreshCoordinator.current = createDashboardRefreshCoordinator({
      execute: (context) => dashboardRefreshExecutor.current(context),
      instrumentation: { enabled: DASHBOARD_COMMAND_TRACE_ENABLED },
    });
  }
  const dashboardCoordinator = dashboardRefreshCoordinator.current;

  dashboardRefreshExecutor.current = async ({ keys, isAuthoritative }) => {
    if (!runtimeAvailable) return;
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        const userInitiated = userRetryKeys.current.has(key);
        const dirtyVersion = dirtyResourceVersionsRef.current[key] ?? 0;
        const selectedRunId = selectedRunIdRef.current;
        const selectedRetroId = selectedRetroIdRef.current;
        if (isAuthoritative(key)) beginDashboardResourceRefresh(key);
        try {
          switch (key) {
            case "overview": {
              const next = await loadDashboardResource(key, desktopCommands.getOverview);
              if (isAuthoritative(key)) {
                commitResourceSuccess("overview", next);
              }
              break;
            }
            case "runs": {
              const next = await loadDashboardResource(key, desktopCommands.listRuns);
              if (isAuthoritative(key)) {
                commitResourceSuccess("runs", next);
              }
              break;
            }
            case "issues": {
              const next = await loadDashboardResource(key, desktopCommands.listIssues);
              if (isAuthoritative(key)) {
                commitResourceSuccess("issues", next);
                const byId = new Map(next.map((issue) => [issue.id, issue]));
                const updateRunIssue = (run: RunWithIssueRow): RunWithIssueRow => {
                  const issue = byId.get(run.issue_id);
                  return issue
                    ? { ...run, issue_title: issue.title, issue_state: issue.state }
                    : run;
                };
                setRuns((current) => current.map(updateRunIssue));
                setSelectedRun((current) =>
                  current ? { ...current, run: updateRunIssue(current.run) } : current,
                );
              }
              break;
            }
            case "worker": {
              const next = await loadDashboardResource(key, desktopCommands.getWorkerStatus);
              if (isAuthoritative(key)) {
                commitResourceSuccess("worker", next);
              }
              break;
            }
            case "retroList": {
              const [nextStatus, nextRetros] = await Promise.all([
                loadDashboardResource(key, desktopCommands.getRetroStatus),
                loadDashboardResource(key, desktopCommands.listRetros),
              ]);
              if (isAuthoritative(key)) {
                commitResourceSuccess("retroList", {
                  retroStatus: nextStatus,
                  retros: nextRetros,
                });
                if (selectedRetroIdRef.current === null) {
                  selectedRetroIdRef.current = nextRetros[0]?.id ?? null;
                  if (selectedRetroIdRef.current !== null && viewRef.current === "retro") {
                    markResourceDirty("selectedRetro");
                    void dashboardCoordinator.request(["selectedRetro"], {
                      reportFailure: false,
                    });
                  }
                }
              }
              break;
            }
            case "retroBatches": {
              const next = await loadDashboardResource(
                key,
                desktopCommands.hasInProgressRetroBatches,
              );
              if (isAuthoritative(key)) {
                commitResourceSuccess("retroBatches", next);
              }
              break;
            }
            case "selectedRun": {
              if (!selectedRunId) break;
              const appendVersion = localAppendVersionRef.current;
              const next = await loadDashboardResource(key, () =>
                desktopCommands.getRunDetail(selectedRunId),
              );
              if (isAuthoritative(key) && selectedRunId === selectedRunIdRef.current) {
                const current = selectedRunRef.current;
                let committed = next;
                if (
                  localAppendVersionRef.current !== appendVersion &&
                  current?.run.id === selectedRunId
                ) {
                  if (!next) {
                    committed = current;
                  } else {
                    const eventIds = new Set(next.events.map((event) => event.id));
                    committed = {
                      ...next,
                      events: [
                        ...next.events,
                        ...current.events.filter((event) => !eventIds.has(event.id)),
                      ],
                    };
                  }
                }
                selectedRunRef.current = committed;
                commitResourceSuccess("selectedRun", committed);
                if (!committed) selectedRunIdRef.current = null;
              }
              break;
            }
            case "selectedRetro": {
              if (!selectedRetroId) break;
              const next = await loadDashboardResource(key, () =>
                desktopCommands.getRetroDetail(selectedRetroId),
              );
              if (isAuthoritative(key) && selectedRetroId === selectedRetroIdRef.current) {
                commitResourceSuccess("selectedRetro", next);
                if (!next) selectedRetroIdRef.current = null;
              }
              break;
            }
          }
          if (
            isAuthoritative(key) &&
            (dirtyResourceVersionsRef.current[key] ?? 0) === dirtyVersion
          ) {
            dirtyResourcesRef.current.delete(key);
          }
        } catch (refreshError) {
          if (isAuthoritative(key)) {
            commitResourceFailure(key, refreshError, userInitiated);
          }
          throw refreshError;
        } finally {
          if (isAuthoritative(key)) finishDashboardResourceRefresh(key);
        }
      }),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      const failure = new Error(
        `${failures.length} dashboard resource refresh ${failures.length === 1 ? "failed" : "failures"}`,
      ) as Error & { causes: unknown[] };
      failure.causes = failures.map((result) => result.reason);
      throw failure;
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependencies are ref-backed helpers intentionally held stable across renders.
  const requestInvalidatedResources = useCallback(
    (
      keys: Iterable<DashboardResourceKey>,
      options: { reportFailure?: boolean } = { reportFailure: false },
      markDirty = true,
    ) => {
      const invalidated = [...new Set(keys)];
      if (markDirty) invalidated.forEach(markResourceDirty);
      const fetchable = visibleResources(
        invalidated,
        viewRef.current,
        selectedRunIdRef.current,
        selectedRetroIdRef.current,
      );
      return dashboardCoordinator.request(fetchable, options);
    },
    [],
  );

  const refreshDashboard = useCallback(
    () => requestInvalidatedResources(DASHBOARD_RESOURCE_KEYS, { reportFailure: true }),
    [requestInvalidatedResources],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the coordinator and dirty tracker are stable ref-backed helpers.
  const retryDashboardResource = useCallback(async (key: DashboardResourceKey) => {
    userRetryKeys.current.add(key);
    markResourceDirty(key);
    try {
      await dashboardCoordinator.request([key], {
        rejectOnFailure: true,
        reportFailure: false,
      });
    } catch {
      // A user-triggered retry gets one assertive announcement per failure
      // episode. Repeated retries stay quiet until a successful recovery.
      if (!userFailureAnnouncedKeys.current.has(key)) {
        const summary = dashboardResourcesRef.current[key].error?.summary;
        if (summary) {
          userFailureAnnouncedKeys.current.add(key);
          setResourceAnnouncement({
            id: ++resourceAnnouncementSequence.current,
            key,
            role: "alert",
            message: summary,
          });
        }
      }
    } finally {
      userRetryKeys.current.delete(key);
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the updater writes through refs and must keep stable callback identity.
  const markVisibleResourceStale = useCallback((key: DashboardResourceKey, nowMs: number) => {
    const current = dashboardResourcesRef.current[key] as DashboardResourceEnvelope<
      DashboardResourceData[typeof key]
    >;
    const next = staleDirtyResource(current, nowMs, true);
    if (next === current) return;
    updateDashboardResource(key, () => next);
  }, []);
  const pollDashboardResources = useCallback(
    async (keys: readonly DashboardResourceKey[]) => {
      await dashboardCoordinator.request(keys, {
        rejectOnFailure: true,
        reportFailure: false,
      });
      return Object.fromEntries(
        keys.map((key) => [key, dashboardResourceValues.current.get(key)]),
      ) as Partial<Record<DashboardResourceKey, unknown>>;
    },
    [dashboardCoordinator],
  );

  const updatePollingState = useCallback((key: PollKey, status: PollResourceState) => {
    setPollingStates((current) => ({ ...current, [key]: status }));
  }, []);
  const clearPollingState = useCallback((key: PollKey) => {
    setPollingStates((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    const coordinator = dashboardCoordinator;
    coordinator.activate();
    return () => {
      coordinator.dispose();
      refreshAffordanceTimers.current.forEach((timer) => {
        window.clearTimeout(timer);
      });
      refreshAffordanceTimers.current.clear();
    };
  }, [dashboardCoordinator]);

  useEffect(() => {
    setStoppingRunIds((prev) => {
      if (prev.size === 0) return prev;
      const cancellable = new Set(
        runs
          .filter((run) => run.status === "pending" || run.status === "running")
          .map((run) => run.id),
      );
      const next = new Set([...prev].filter((id) => cancellable.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [runs]);

  useEffect(() => {
    if (!runtimeAvailable) return;

    if (bootState.status === "error") retryButtonRef.current?.focus();
  }, [bootState.status, runtimeAvailable]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrapAttempt is an explicit retry trigger; snapshot commit reads current refs.
  useEffect(() => {
    if (runtimeAvailable) return;
    let cancelled = false;
    loadPreviewRuntime()
      .then(({ previewRuntime }) => {
        if (cancelled) return;
        previewRuntimeRef.current = previewRuntime;
        setSettings(previewRuntime.settings);
        settingsDraftRef.current = previewRuntime.settings;
        setSkillsStatuses(previewRuntime.skillsStatuses);
        setWorkflowStatuses(previewRuntime.workflowStatuses);
        commitDashboardSnapshot(previewRuntime.dashboard);
        setBootState({
          status: "ready",
          payload: {
            settings: previewRuntime.settings,
            dashboard: previewRuntime.dashboard,
            autoStart: null,
          },
        });
        setBootstrapSettled(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setBootState({ status: "error", message: normalizeBootstrapError(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bootstrapAttempt, runtimeAvailable]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrapAttempt intentionally restarts subscriptions; event helpers read current refs.
  useEffect(() => {
    if (!runtimeAvailable) return;

    let cancelled = false;
    let bootstrapPending = true;
    let refreshQueuedDuringBootstrap = false;
    const pendingKeys = new Set<DashboardResourceKey>();

    // Agent events arrive in bursts; coalesce them into a single refresh. An
    // event during bootstrap must run afterward so the initial snapshot cannot
    // overwrite newer dashboard data.
    let timer: number | null = null;
    const scheduleRefresh = (keys: Iterable<DashboardResourceKey>) => {
      for (const key of keys) {
        markResourceDirty(key);
        pendingKeys.add(key);
      }
      pollControllers.current.worker?.reset();
      pollControllers.current.retro?.reset();
      if (bootstrapPending) {
        refreshQueuedDuringBootstrap = true;
        return;
      }
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        const queued = [...pendingKeys];
        pendingKeys.clear();
        void requestInvalidatedResources(queued, { reportFailure: false }, false);
      }, 300);
    };
    const releaseBootstrapRefreshGate = (ready: boolean) => {
      if (cancelled) return;
      bootstrapPending = false;
      if (ready) setBootstrapSettled(true);
      if (ready && refreshQueuedDuringBootstrap) {
        refreshQueuedDuringBootstrap = false;
        scheduleRefresh([]);
      }
    };

    loadBootstrap()
      .then(({ settings: loaded, dashboard, autoStart }) => {
        if (cancelled) return;
        setSettings(loaded);
        if (!settingsDirtyRef.current) settingsDraftRef.current = loaded;
        commitDashboardSnapshot(dashboard);
        setBootState({
          status: "ready",
          payload: { settings: loaded, dashboard, autoStart },
        });
        if (!autoStart) {
          setBootstrapSettled(true);
          releaseBootstrapRefreshGate(true);
          return;
        }
        void autoStart
          .then((nextWorker) => {
            if (!cancelled) setWorker(nextWorker);
          })
          .catch((err) => {
            if (!cancelled) setError(formatError(err));
          })
          .finally(() => releaseBootstrapRefreshGate(true));
      })
      .catch((err) => {
        if (!cancelled) {
          setBootState({ status: "error", message: normalizeBootstrapError(err) });
          releaseBootstrapRefreshGate(false);
        }
      });

    const unsubscribe = subscribeDesktopEvents({
      onDbChanged: (payload) => {
        if (payload.table === "workflows") {
          workflowReadinessDirtyRef.current = true;
          setWorkflowReadinessEpoch((epoch) => epoch + 1);
        }
        let keys = resourcesForDbChange(payload.table);
        if (payload.table === "agent_events" && typedAgentEventAwaitingDbChangeRef.current) {
          typedAgentEventAwaitingDbChangeRef.current = false;
          // Mark selectedRun dirty to supersede any in-flight get_run_detail
          // that may have read the pre-append event list, but don't fetch —
          // the typed event was already appended locally.
          markResourceDirty("selectedRun");
          keys = keys.filter((key) => key !== "selectedRun");
        }
        scheduleRefresh(keys);
      },
      onAgentEvent: (payload) => {
        const nextEvent = payload.event;
        const current = selectedRunRef.current;
        if (
          viewRef.current === "runs" &&
          current?.run.id === nextEvent.run_id &&
          !current.events.some((event) => event.id === nextEvent.id)
        ) {
          const updated = { ...current, events: [...current.events, nextEvent] };
          selectedRunRef.current = updated;
          setSelectedRun(updated);
          typedAgentEventAwaitingDbChangeRef.current = true;
          localAppendVersionRef.current += 1;
        }
        scheduleRefresh(["overview"]);
      },
      onRateLimitChanged: () => {
        scheduleRefresh(["overview"]);
      },
      onError: (err) => {
        if (!cancelled) setError(formatError(err));
      },
    });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [bootstrapAttempt, requestInvalidatedResources, runtimeAvailable]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workflowReadinessEpoch is an explicit invalidation signal, not a captured value.
  useEffect(() => {
    if (!runtimeAvailable || bootState.status !== "ready") return;
    const viewKeys = resourcesForView(view).filter((key) => dirtyResourcesRef.current.has(key));
    void requestInvalidatedResources(viewKeys, { reportFailure: true }, false);
    if (view === "settings" && workflowReadinessDirtyRef.current) {
      workflowReadinessDirtyRef.current = false;
      refreshWorkflowStatus();
    }
    // refreshWorkflowStatus intentionally refreshes readiness only; it never
    // replaces the editable Settings draft.
  }, [
    bootState.status,
    requestInvalidatedResources,
    runtimeAvailable,
    view,
    workflowReadinessEpoch,
  ]);

  function retryBootstrap() {
    if (bootState.status !== "error") return;
    resetBootstrap();
    setError(null);
    setBootstrapSettled(false);
    setBootState({ status: "loading" });
    setView("overview");
    setBootstrapAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    if (!runtimeAvailable || worker.state === "stopped") return;
    const stopping = worker.state === "stopping";
    const controller = createPollController({
      poll: () => pollDashboardResources(["worker"]),
      fingerprint: (resources) => {
        const status = resources.worker as WorkerStatus | undefined;
        return JSON.stringify(
          status
            ? {
                state: status.state,
                startedAt: status.started_at,
                lastError: status.last_error,
              }
            : null,
        );
      },
      baselineMs: stopping ? 500 : 2_000,
      unchangedBackoffMs: stopping ? [] : [4_000, 8_000, 10_000],
      pauseWhenHidden: !stopping,
      failureMaxMs: stopping ? 10_000 : 30_000,
      onResult: (resources) => (resources.worker as WorkerStatus | undefined)?.state !== "stopped",
      onStatus: (status) => updatePollingState("worker", status),
    });
    pollControllers.current.worker = controller;
    controller.start();
    return () => {
      controller.dispose();
      clearPollingState("worker");
      if (pollControllers.current.worker === controller) {
        delete pollControllers.current.worker;
      }
    };
  }, [
    clearPollingState,
    pollDashboardResources,
    runtimeAvailable,
    updatePollingState,
    worker.state,
  ]);

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

  const refreshLinearViewer = useCallback(
    (exactSettings: AppSettings, exactKey: string) => {
      if (!runtimeAvailable || !exactSettings.tracker_assigned_to_me) {
        linearViewerSeq.current += 1;
        setLinearViewer(null);
        setLinearViewerLoading(false);
        setLinearViewerError(null);
        return;
      }

      const typedKey = exactKey.trim();
      if (!exactSettings.linear_api_key_set && typedKey === "") {
        linearViewerSeq.current += 1;
        setLinearViewer(null);
        setLinearViewerLoading(false);
        setLinearViewerError("Add a Linear API key to show the current user.");
        return;
      }

      const seq = linearViewerSeq.current + 1;
      linearViewerSeq.current = seq;
      setLinearViewerLoading(true);
      setLinearViewerError(null);
      desktopCommands
        .getLinearViewer({
          settings: exactSettings,
          linear_api_key: typedKey ? typedKey : null,
        })
        .then((viewer) => {
          if (linearViewerSeq.current !== seq) return;
          setLinearViewer(viewer);
        })
        .catch((err) => {
          if (linearViewerSeq.current !== seq) return;
          setLinearViewer(null);
          setLinearViewerError(formatError(err));
        })
        .finally(() => {
          if (linearViewerSeq.current !== seq) return;
          setLinearViewerLoading(false);
        });
    },
    [runtimeAvailable],
  );

  useEffect(() => {
    if (settings) refreshLinearViewer(settings, linearKeyDraftRef.current);
  }, [refreshLinearViewer, settings]);

  const handleSettingsDraftChange = useCallback(
    (next: AppSettings, nextKey: string, previous: AppSettings) => {
      if (
        next === previous ||
        next.tracker_assigned_to_me !== previous.tracker_assigned_to_me ||
        next.linear_api_key_set !== previous.linear_api_key_set
      ) {
        refreshLinearViewer(next, nextKey);
      }
      if (
        stableSessionEnvKey(next.session_env) !== stableSessionEnvKey(previous.session_env) ||
        configuredRepoUrls(next).join("\n") !== configuredRepoUrls(previous).join("\n")
      ) {
        queueRepoStatusRefreshRef.current(next);
      }
    },
    [refreshLinearViewer],
  );

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

  async function saveSettings(
    exactSettings: AppSettings,
    exactLinearKey: string,
    result: ValidationResult,
  ) {
    setValidation(result);
    if (result.workflow_blocking) return;
    const saved = await call(() =>
      desktopCommands.saveSettings({
        settings: exactSettings,
        linear_api_key: exactLinearKey.trim() ? exactLinearKey : null,
      }),
    );
    setSettings(saved);
    let refreshedWorker: WorkerStatus | null = null;
    try {
      refreshedWorker = await desktopCommands.getWorkerStatus();
      setWorker(refreshedWorker);
    } catch {
      // Settings are saved even if this status refresh fails; the next dashboard
      // refresh will reconcile worker state.
    }
    const liveWorkerState = refreshedWorker?.state ?? worker.state;
    setSavedLiveConfigKept(
      liveWorkerState === "running" &&
        (!result.workflow_ok || refreshedWorker?.last_error !== null),
    );
    const currentDraft = settingsDraftRef.current;
    const refreshTarget =
      currentDraft && formSnapshot(currentDraft) !== formSnapshot(exactSettings)
        ? currentDraft
        : saved;
    queueRepoStatusRefreshRef.current(refreshTarget);
    setSavedFlash(true);
    if (savedFlashTimer.current !== null) {
      window.clearTimeout(savedFlashTimer.current);
    }
    savedFlashTimer.current = window.setTimeout(() => {
      setSavedFlash(false);
      setSavedLiveConfigKept(false);
    }, 2500);
    return saved;
  }

  async function testConnection(exactSettings: AppSettings, exactLinearKey: string) {
    const result = await call(() =>
      desktopCommands.testTrackerConnection({
        settings: exactSettings,
        linear_api_key: exactLinearKey.trim() ? exactLinearKey : null,
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
  // overwrite the post-install refresh that already saw the PR. The session
  // env is part of the context because token edits change the auth outcome for
  // the same repo URL.
  function checkRepoSkills(url: string, sessionEnv = settings?.session_env ?? {}) {
    const repoUrl = url.trim();
    if (!runtimeAvailable || repoUrl === "") return;
    const contextKey = skillsCheckContextKey(repoUrl, sessionEnv);
    const seq = (skillsCheckSeq.current[repoUrl] ?? 0) + 1;
    skillsCheckSeq.current[repoUrl] = seq;
    skillsCheckContext.current[repoUrl] = contextKey;
    setSkillsChecking((prev) => ({ ...prev, [repoUrl]: true }));
    desktopCommands
      .getSkillsStatus(repoUrl, sessionEnv)
      .then((status) => {
        if (
          skillsCheckSeq.current[repoUrl] !== seq ||
          skillsCheckContext.current[repoUrl] !== contextKey
        ) {
          return;
        }
        setSkillsStatuses((prev) => ({ ...prev, [repoUrl]: status }));
        // A fresh check supersedes a finished install for the same repo —
        // without this, a completed install keeps showing its PR forever.
        setSkillsInstall((prev) =>
          prev?.state !== "running" && prev?.repo_url === repoUrl ? null : prev,
        );
      })
      .catch(() => {
        if (
          skillsCheckSeq.current[repoUrl] !== seq ||
          skillsCheckContext.current[repoUrl] !== contextKey
        ) {
          return;
        }
        setSkillsStatuses((prev) => {
          const next = { ...prev };
          delete next[repoUrl];
          return next;
        });
      })
      .finally(() => {
        if (
          skillsCheckSeq.current[repoUrl] !== seq ||
          skillsCheckContext.current[repoUrl] !== contextKey
        ) {
          return;
        }
        setSkillsChecking((prev) => ({ ...prev, [repoUrl]: false }));
      });
  }

  function refreshSkillsStatus(forSettings?: AppSettings) {
    const target = forSettings ?? settings;
    if (!target) return;
    for (const url of configuredRepoUrls(target)) checkRepoSkills(url, target.session_env);
  }

  async function startSkillsInstall(exactSettings: AppSettings, url: string) {
    skillsInstallSettingsRef.current = exactSettings;
    const status = await call(() => desktopCommands.installSkills(exactSettings, url.trim()));
    setSkillsInstall(status);
  }

  function checkRepoWorkflow(url: string, sessionEnv = settings?.session_env ?? {}) {
    const repoUrl = url.trim();
    if (!runtimeAvailable || repoUrl === "") return;
    const contextKey = skillsCheckContextKey(repoUrl, sessionEnv);
    const seq = (workflowCheckSeq.current[repoUrl] ?? 0) + 1;
    workflowCheckSeq.current[repoUrl] = seq;
    workflowCheckContext.current[repoUrl] = contextKey;
    setWorkflowChecking((prev) => ({ ...prev, [repoUrl]: true }));
    desktopCommands
      .getRepoWorkflowStatus(repoUrl, sessionEnv)
      .then((status) => {
        if (
          workflowCheckSeq.current[repoUrl] !== seq ||
          workflowCheckContext.current[repoUrl] !== contextKey
        ) {
          return;
        }
        setWorkflowStatuses((prev) => ({ ...prev, [repoUrl]: status }));
        setWorkflowTransfer((prev) =>
          prev?.state !== "running" && prev?.repo_url === repoUrl ? null : prev,
        );
      })
      .catch(() => {
        if (
          workflowCheckSeq.current[repoUrl] !== seq ||
          workflowCheckContext.current[repoUrl] !== contextKey
        ) {
          return;
        }
        setWorkflowStatuses((prev) => {
          const next = { ...prev };
          delete next[repoUrl];
          return next;
        });
      })
      .finally(() => {
        if (
          workflowCheckSeq.current[repoUrl] === seq &&
          workflowCheckContext.current[repoUrl] === contextKey
        ) {
          setWorkflowChecking((prev) => ({ ...prev, [repoUrl]: false }));
        }
      });
  }

  function refreshWorkflowStatus(forSettings?: AppSettings) {
    const target = forSettings ?? settings;
    if (!target) return;
    for (const url of configuredRepoUrls(target)) {
      checkRepoWorkflow(url, target.session_env);
    }
  }

  async function startWorkflowTransfer(url: string) {
    const status = await call(() => desktopCommands.transferWorkflowToRepo(url.trim()));
    setWorkflowTransfer(status);
  }

  // Check the latest draft context once URL/auth edits settle. The ref-backed
  // scheduler lets Settings publish frequent draft changes without subscribing
  // App state to them, while replacing one pending timer with the newest full
  // settings snapshot. Updating context refs immediately also prevents an
  // already-running check from rendering against superseding credentials.
  queueRepoStatusRefreshRef.current = (target) => {
    if (repoStatusRefreshTimer.current !== null) {
      window.clearTimeout(repoStatusRefreshTimer.current);
      repoStatusRefreshTimer.current = null;
    }
    if (!runtimeAvailable) return;
    const urls = configuredRepoUrls(target);
    const sessionEnv = target.session_env;
    for (const url of urls) {
      const contextKey = skillsCheckContextKey(url, sessionEnv);
      skillsCheckContext.current[url] = contextKey;
      workflowCheckContext.current[url] = contextKey;
    }
    if (urls.length === 0) return;
    repoStatusRefreshTimer.current = window.setTimeout(() => {
      repoStatusRefreshTimer.current = null;
      for (const url of urls) {
        checkRepoSkills(url, sessionEnv);
        checkRepoWorkflow(url, sessionEnv);
      }
    }, 600);
  };

  const savedRepoStatusKey =
    settings === null
      ? null
      : `${configuredRepoUrls(settings).join("\n")}\n${stableSessionEnvKey(settings.session_env)}`;
  useEffect(() => {
    if (!settings || savedRepoStatusKey === null) return;
    const target = settingsDirtyRef.current ? (settingsDraftRef.current ?? settings) : settings;
    queueRepoStatusRefreshRef.current(target);
  }, [savedRepoStatusKey, settings]);

  useEffect(
    () => () => {
      if (repoStatusRefreshTimer.current !== null) {
        window.clearTimeout(repoStatusRefreshTimer.current);
      }
    },
    [],
  );

  // While the install session runs, poll its progress; when it lands, re-check
  // its repo so that card's status flips to "PR open" with the link.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the polling callback intentionally uses the current ref-backed repo checker.
  useEffect(() => {
    if (!runtimeAvailable || skillsInstall?.state !== "running") return;
    const controller = createPollController({
      poll: desktopCommands.getSkillsInstallStatus,
      fingerprint: (status) =>
        JSON.stringify({
          state: status.state,
          repoUrl: status.repo_url,
          message: status.message,
          prUrl: status.pr_url,
          error: status.error,
        }),
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: (status) => {
        setSkillsInstall(status);
        if (status.state === "completed" && status.repo_url) {
          checkRepoSkills(status.repo_url, skillsInstallSettingsRef.current?.session_env);
        }
        if (status.state !== "running") skillsInstallSettingsRef.current = null;
        return status.state === "running";
      },
      onStatus: (status) => updatePollingState("skillsInstall", status),
    });
    pollControllers.current.skillsInstall = controller;
    controller.start();
    return () => {
      controller.dispose();
      clearPollingState("skillsInstall");
      if (pollControllers.current.skillsInstall === controller) {
        delete pollControllers.current.skillsInstall;
      }
    };
  }, [clearPollingState, runtimeAvailable, skillsInstall?.state, updatePollingState]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the polling callback intentionally uses the current ref-backed repo checker.
  useEffect(() => {
    if (!runtimeAvailable || workflowTransfer?.state !== "running") return;
    const controller = createPollController({
      poll: desktopCommands.getWorkflowTransferStatus,
      fingerprint: (status) =>
        JSON.stringify({
          state: status.state,
          repoUrl: status.repo_url,
          message: status.message,
          prUrl: status.pr_url,
          error: status.error,
        }),
      baselineMs: 2_000,
      unchangedBackoffMs: [4_000, 8_000, 10_000],
      pauseWhenHidden: true,
      onResult: (status) => {
        setWorkflowTransfer(status);
        if (status.state === "completed" && status.repo_url) {
          checkRepoWorkflow(status.repo_url);
        }
        return status.state === "running";
      },
      onStatus: (status) => updatePollingState("workflowTransfer", status),
    });
    pollControllers.current.workflowTransfer = controller;
    controller.start();
    return () => {
      controller.dispose();
      clearPollingState("workflowTransfer");
      if (pollControllers.current.workflowTransfer === controller) {
        delete pollControllers.current.workflowTransfer;
      }
    };
  }, [clearPollingState, runtimeAvailable, updatePollingState, workflowTransfer?.state]);

  async function removeLinearKey() {
    const fromDisk = await call(desktopCommands.removeLinearApiKey);
    setSettings((current) =>
      current ? { ...current, linear_api_key_set: fromDisk.linear_api_key_set } : current,
    );
    linearKeyDraftRef.current = "";
    setTrackerTest(null);
    return fromDisk.linear_api_key_set;
  }

  async function resetPrompt() {
    return call(desktopCommands.getDefaultPrompt);
  }

  async function startWorker() {
    if (!bootstrapSettled) return;
    const status = await call(desktopCommands.startWorker);
    setWorker(status);
  }

  async function stopWorker() {
    if (!bootstrapSettled) return;
    const status = await call(desktopCommands.stopWorker);
    setWorker(status);
  }

  async function openRun(id: string) {
    if (!runtimeAvailable) {
      const run = runs.find((candidate) => candidate.id === id);
      const preview = previewRuntimeRef.current;
      if (!run || !preview) return;
      selectedRunIdRef.current = id;
      setSelectedRun({ run, events: preview.eventsByRunId[id] ?? [] });
      setView("runs");
      return;
    }
    selectedRunIdRef.current = id;
    resetDashboardResource("selectedRun");
    viewRef.current = "runs";
    setView("runs");
    await requestInvalidatedResources(["selectedRun"], { reportFailure: true });
  }

  async function stopRun(id: string) {
    setStoppingRunIds((prev) => new Set(prev).add(id));
    if (!runtimeAvailable) {
      window.setTimeout(() => {
        const endedAt = new Date().toISOString();
        const cancelRun = (run: RunWithIssueRow): RunWithIssueRow =>
          run.id === id
            ? {
                ...run,
                status: "cancelled",
                ended_at: endedAt,
                error_class: "cancelled",
                error_message: "run cancelled",
              }
            : run;
        const event: AgentEventRow = {
          id: Date.now(),
          run_id: id,
          kind: "status",
          payload: JSON.stringify({ message: "Run cancellation requested" }),
          created_at: endedAt,
        };
        setRuns((prev) => prev.map(cancelRun));
        setOverview((prev) => ({
          ...prev,
          active_runs: prev.active_runs.filter((run) => run.id !== id),
          live_sessions: prev.live_sessions.filter((session) => session.run_id !== id),
        }));
        setSelectedRun((prev) =>
          prev?.run.id === id
            ? { run: cancelRun(prev.run), events: [...prev.events, event] }
            : prev,
        );
        setStoppingRunIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 800);
      return;
    }
    try {
      const detail = await call(() => desktopCommands.stopRun(id));
      if (selectedRunIdRef.current === id) setSelectedRun(detail);
      await refreshDashboard();
    } catch {
      // call() or the refresh coordinator has already surfaced the failure.
    } finally {
      setStoppingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function triggerRetryNow(issueId: string) {
    setTriggeringRetryIds((prev) => new Set(prev).add(issueId));
    try {
      await call(() => desktopCommands.triggerRetryNow(issueId));
      await refreshDashboard();
    } catch {
      // call() has already surfaced the error banner.
    } finally {
      setTriggeringRetryIds((prev) => {
        const next = new Set(prev);
        next.delete(issueId);
        return next;
      });
    }
  }

  async function startRetro() {
    if (!settings) return;
    if (!runtimeAvailable) {
      const preview = previewRuntimeRef.current;
      if (!preview) return;
      setRetroStatus(preview.retroStatus);
      setRetros(preview.retros);
      setSelectedRetro(preview.retroDetail);
      selectedRetroIdRef.current = preview.retroReportId;
      setView("retro");
      return;
    }
    const status = await call(desktopCommands.startRetro);
    setRetroStatus(status);
    selectedRetroIdRef.current = status.retro_id;
    setSelectedRetro(null);
    await refreshDashboard();
    setView("retro");
  }

  async function openRetro(id: string) {
    if (!runtimeAvailable) {
      const preview = previewRuntimeRef.current;
      if (!preview) return;
      selectedRetroIdRef.current = id;
      setSelectedRetro(preview.retroDetailForId(id));
      setView("retro");
      return;
    }
    selectedRetroIdRef.current = id;
    resetDashboardResource("selectedRetro");
    viewRef.current = "retro";
    setView("retro");
    await requestInvalidatedResources(["selectedRetro"], { reportFailure: true });
  }

  async function deleteRetro(id: string) {
    const index = retros.findIndex((retro) => retro.id === id);
    const remaining = retros.filter((retro) => retro.id !== id);
    const nextRetro = remaining[index] ?? remaining[index - 1] ?? remaining[0] ?? null;
    if (!runtimeAvailable) {
      const preview = previewRuntimeRef.current;
      if (!preview) return;
      setRetros(remaining);
      selectedRetroIdRef.current = nextRetro?.id ?? null;
      setSelectedRetro(nextRetro ? preview.retroDetailForId(nextRetro.id) : null);
      setRetroStatus((current) => (current.retro_id === id ? emptyRetroStatus : current));
      return;
    }
    try {
      await call(() => desktopCommands.deleteRetro(id));
    } catch {
      return;
    }
    selectedRetroIdRef.current = nextRetro?.id ?? null;
    setSelectedRetro(null);
    await refreshDashboard();
  }

  async function decideRetroSuggestion(id: string, decision: string) {
    if (!runtimeAvailable) {
      setSelectedRetro((current) =>
        current
          ? {
              ...current,
              suggestions: current.suggestions.map((suggestion) =>
                suggestion.id === id
                  ? {
                      ...suggestion,
                      decision,
                      decided_at: decision === "pending" ? null : new Date().toISOString(),
                    }
                  : suggestion,
              ),
            }
          : current,
      );
      return;
    }
    const updated = await call(() => desktopCommands.setRetroSuggestionDecision(id, decision));
    setSelectedRetro((current) =>
      current
        ? {
            ...current,
            suggestions: current.suggestions.map((suggestion) =>
              suggestion.id === updated.id ? updated : suggestion,
            ),
          }
        : current,
    );
  }

  async function applyRetroWorkflow(retroId: string) {
    const batch = await call(() => desktopCommands.applyRetroWorkflow(retroId));
    if (["queued", "running"].includes(batch.state)) {
      setHasInProgressRetroBatches(true);
    }
    setSelectedRetro((current) =>
      current?.row.id === retroId ? { ...current, batches: [...current.batches, batch] } : current,
    );
    const saved = await desktopCommands.loadSettings();
    setSettings(saved);
    if (!settingsDirtyRef.current) settingsDraftRef.current = saved;
    await refreshDashboard();
  }

  async function startRetroPrs(retroId: string) {
    if (!settings) return;
    const batches = await call(() => desktopCommands.startRetroPrs(retroId));
    if (batches.some((batch) => ["queued", "running"].includes(batch.state))) {
      setHasInProgressRetroBatches(true);
    }
    setSelectedRetro((current) =>
      current?.row.id === retroId ? { ...current, batches } : current,
    );
    await refreshDashboard();
  }

  useEffect(() => {
    if (!runtimeAvailable || (retroStatus.state !== "running" && !hasInProgressRetroBatches)) {
      return;
    }
    const keys: DashboardResourceKey[] = ["retroList", "retroBatches"];
    if (view === "retro" && selectedRetroIdRef.current) keys.push("selectedRetro");
    const controller = createPollController({
      poll: () => pollDashboardResources(keys),
      fingerprint: (resources) => {
        const retroList = resources.retroList as
          | { retroStatus: RetroStatus; retros: RetroRow[] }
          | undefined;
        return JSON.stringify({
          status: (() => {
            const status = retroList?.retroStatus;
            return status
              ? {
                  state: status.state,
                  retroId: status.retro_id,
                  message: status.message,
                  report: status.report,
                  error: status.error,
                }
              : null;
          })(),
          retros: retroList?.retros?.map(retroRowRenderedFields),
          detail: retroDetailRenderedFields(
            resources.selectedRetro as RetroDetail | null | undefined,
          ),
          hasInProgressBatches: resources.retroBatches,
        });
      },
      baselineMs: 1_500,
      unchangedBackoffMs: [3_000, 6_000],
      pauseWhenHidden: true,
      onResult: (resources) => {
        const retroList = resources.retroList as
          | { retroStatus: RetroStatus; retros: RetroRow[] }
          | undefined;
        return retroList?.retroStatus?.state === "running" || resources.retroBatches === true;
      },
      onStatus: (status) => updatePollingState("retro", status),
    });
    pollControllers.current.retro = controller;
    controller.start();
    return () => {
      controller.dispose();
      clearPollingState("retro");
      if (pollControllers.current.retro === controller) {
        delete pollControllers.current.retro;
      }
    };
  }, [
    hasInProgressRetroBatches,
    clearPollingState,
    pollDashboardResources,
    retroStatus.state,
    runtimeAvailable,
    updatePollingState,
    view,
  ]);

  // `blocked` covers the hard requirements without which runs cannot work;
  // it gates the worker-start affordances, overview onboarding, and matches
  // the boot auto-start condition. Skills are recommended only and live in
  // Settings, so they must not keep the overview onboarding visible.
  const setupBlocked =
    settings !== null && (!settings.linear_api_key_set || !anyRepoConfigured(settings));
  const setup = {
    blocked: setupBlocked,
    linearConnected: settings?.linear_api_key_set ?? false,
    repoConfigured: settings !== null && anyRepoConfigured(settings),
  };

  const dirty = settingsDirty;
  const liveReconfigureSkipped =
    worker.state === "running" &&
    ((validation?.workflow_ok === false && !validation.workflow_blocking) ||
      (savedFlash && savedLiveConfigKept));

  // Repo skill detection does not depend on the selected agent or its command,
  // so it only needs refreshing when Settings are entered or first loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: entering Settings or first loading settings are the deliberate refresh triggers.
  useEffect(() => {
    if (!runtimeAvailable || view !== "settings" || !settings) return;
    const target = settingsDirtyRef.current ? (settingsDraftRef.current ?? settings) : settings;
    refreshSkillsStatus(target);
    refreshWorkflowStatus(target);
  }, [view, runtimeAvailable, settings !== null]);

  function requestStop() {
    if (overview.active_runs.length > 0 && !confirmStop) {
      setConfirmStop(true);
      if (confirmStopTimer.current !== null) {
        window.clearTimeout(confirmStopTimer.current);
      }
      confirmStopTimer.current = window.setTimeout(() => setConfirmStop(false), 4000);
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

  const bootReady = bootState.status === "ready";
  const AppUpdateComponent = useDeferredUpdater(bootReady && runtimeAvailable && !IS_LOCAL_DEV);
  const visibleDashboardResourceKeys = visibleResources(
    DASHBOARD_RESOURCE_KEYS,
    view,
    selectedRunIdRef.current,
    selectedRetroIdRef.current,
  );
  const panelResourceKeys = resourcesForView(view).filter((key) =>
    visibleDashboardResourceKeys.includes(key),
  );
  const bootNavigationReason =
    bootState.status === "loading"
      ? runtimeAvailable
        ? "Connecting."
        : "Loading preview…"
      : bootState.status === "error"
        ? "Reconnecting."
        : null;

  const updateBackgroundWork = [
    retroStatus.state === "running" ? "the active Retro" : null,
    skillsInstall?.state === "running" ? "the skills installation" : null,
    workflowTransfer?.state === "running" ? "the workflow transfer" : null,
    hasInProgressRetroBatches ? "an active Retro change batch" : null,
  ].filter((item): item is string => item !== null);
  const stalePollingEntries = (
    Object.entries(pollingStates) as [PollKey, PollResourceState][]
  ).filter(([, status]) => status.stale);

  return (
    <main className="app">
      {bootReady ? (
        <ResourceStalenessMonitor
          resources={dashboardResources}
          visibleKeys={visibleDashboardResourceKeys}
          onStale={markVisibleResourceStale}
        />
      ) : null}
      <header className="topbar">
        <div className="topbar-primary">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <WaveMark />
            </div>
            <h1>Symphony</h1>
            {IS_LOCAL_DEV ? (
              <span className="brand-dev-pill" title="Local development instance">
                Dev
              </span>
            ) : null}
            {bootReady && AppUpdateComponent ? (
              <AppUpdateComponent
                overview={overview}
                backgroundWork={updateBackgroundWork}
                hasInProgressRetroBatches={hasInProgressRetroBatches}
                hasUnsavedSettings={dirty}
                settingsDraft={settingsDraftRef.current}
                pendingLinearKey={linearKeyDraftRef.current}
                transientBusy={busy}
                onWorkerChange={setWorker}
                onOverviewChange={setOverview}
                onRetroBatchWorkChange={setHasInProgressRetroBatches}
                onInstallLockChange={setBusy}
                onActionError={setError}
              />
            ) : null}
          </div>

          <nav className="topnav" aria-label="Primary">
            {(["overview", "runs", "issues", "retro", "settings"] as View[]).map((item) => (
              <button
                type="button"
                key={item}
                className={view === item ? "nav-active" : ""}
                aria-current={view === item ? "page" : undefined}
                aria-describedby={!bootReady && item !== "overview" ? "boot-nav-reason" : undefined}
                disabled={runtimeAvailable && !bootReady && item !== "overview"}
                onPointerEnter={() => preloadView(item)}
                onFocus={() => preloadView(item)}
                onClick={() => setView(item)}
              >
                {label(item)}
              </button>
            ))}
          </nav>
          {bootNavigationReason ? (
            <span className="boot-nav-reason" id="boot-nav-reason">
              {bootNavigationReason}
            </span>
          ) : null}
        </div>

        <div className="topbar-actions">
          {view === "settings" && settings ? (
            <ChunkErrorBoundary
              key={`settings-header-${viewAttempts.settings}`}
              view="Settings actions"
              onRetry={() => retryView("settings")}
            >
              <Suspense fallback={null}>
                <SettingsHeaderActions
                  validation={validation}
                  dirty={dirty}
                  savedFlash={savedFlash}
                  workerRunning={worker.state === "running"}
                  workerConfigError={worker.state === "running" && worker.last_error !== null}
                  liveReconfigureSkipped={liveReconfigureSkipped}
                  busy={busy || settingsSavePending}
                  runtimeAvailable={runtimeAvailable}
                />
              </Suspense>
            </ChunkErrorBoundary>
          ) : null}
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          {bootReady ? (
            <button
              type="button"
              className={`worker-toggle ${worker.state}${confirmStop ? " confirm" : ""}`}
              disabled={
                !bootstrapSettled || busy || !runtimeAvailable || worker.state === "stopping"
              }
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
          ) : null}
        </div>
      </header>

      <section
        className={view === "runs" ? "content content-viewport" : "content"}
        aria-busy={bootState.status === "loading" ? "true" : undefined}
      >
        {bootState.status === "loading" ? <BootLoading preview={!runtimeAvailable} /> : null}
        {bootState.status === "error" ? (
          <BootError
            message={bootState.message}
            onRetry={retryBootstrap}
            retryButtonRef={retryButtonRef}
          />
        ) : null}
        {bootReady && !runtimeAvailable ? (
          <RuntimeBanner
            title="Desktop runtime unavailable"
            message="This browser preview is disconnected from Tauri commands. Launch the desktop app to load live data, save settings, and start the worker."
          />
        ) : null}
        {bootReady && resourceAnnouncement ? (
          <div
            key={resourceAnnouncement.id}
            className="screen-reader-only"
            role={resourceAnnouncement.role}
          >
            {resourceAnnouncement.message}
          </div>
        ) : null}
        {bootReady && error ? <div className="banner error">{error}</div> : null}
        {bootReady && stalePollingEntries.length > 0 ? (
          <div className="banner error" role="status">
            <strong>Background updates delayed</strong>
            <span>
              {stalePollingEntries
                .map(([key, status]) => `${POLL_LABELS[key]}: ${formatError(status.error)}`)
                .join(" · ")}
            </span>
          </div>
        ) : null}
        {bootReady && worker.last_error ? (
          <div className="banner error">
            <strong>
              {worker.state === "running" ? "Worker configuration" : "Worker stopped"}
            </strong>
            <span>{friendlyError(worker.last_error)}</span>
          </div>
        ) : null}
        {bootReady ? (
          <ResourceNotices
            resources={dashboardResources}
            resourceKeys={panelResourceKeys}
            slowRefreshingKeys={slowRefreshingKeys}
            onRetry={retryDashboardResource}
          />
        ) : null}

        {bootReady && view === "overview" ? (
          <OverviewView
            overview={overview}
            canStartWorker={
              bootstrapSettled && runtimeAvailable && !busy && worker.state === "stopped"
            }
            canTriggerRetry={runtimeAvailable && !busy && worker.state === "running"}
            workerRunning={worker.state === "running"}
            setup={setup}
            multiRepo={multiRepo}
            onOpenRun={openRun}
            onStartWorker={startWorker}
            onTriggerRetryNow={triggerRetryNow}
            triggeringRetryIds={triggeringRetryIds}
            onOpenSettings={() => setView("settings")}
            onOpenIssues={() => setView("issues")}
          />
        ) : null}
        {bootReady && view === "runs" ? (
          <ChunkErrorBoundary
            key={`runs-${viewAttempts.runs}`}
            view="Runs"
            onRetry={() => retryView("runs")}
          >
            <Suspense fallback={<ViewLoading view="Runs" />}>
              <RunsView
                runs={runs}
                selected={selectedRun}
                activeRunIds={activeRunIds}
                multiRepo={multiRepo}
                onOpenRun={openRun}
                onStopRun={stopRun}
                canTriggerRetry={runtimeAvailable && !busy && worker.state === "running"}
                onTriggerRetryNow={triggerRetryNow}
                triggeringRetryIds={triggeringRetryIds}
                stoppingRunIds={stoppingRunIds}
              />
            </Suspense>
          </ChunkErrorBoundary>
        ) : null}
        {bootReady && view === "issues" ? (
          <ChunkErrorBoundary
            key={`issues-${viewAttempts.issues}`}
            view="Issues"
            onRetry={() => retryView("issues")}
          >
            <Suspense fallback={<ViewLoading view="Issues" />}>
              <IssuesView
                issues={issues}
                linearWorkspace={settings?.tracker_workspace ?? null}
                onOpenSettings={() => setView("settings")}
              />
            </Suspense>
          </ChunkErrorBoundary>
        ) : null}
        {bootReady && view === "retro" ? (
          <ChunkErrorBoundary
            key={`retro-${viewAttempts.retro}`}
            view="Retro"
            onRetry={() => retryView("retro")}
          >
            <Suspense fallback={<ViewLoading view="Retro" />}>
              <RetroView
                retros={retros}
                status={retroStatus}
                selected={selectedRetro}
                runtimeAvailable={runtimeAvailable}
                busy={busy}
                settingsDirty={dirty}
                setupBlocked={setup.blocked}
                onStartRetro={startRetro}
                onOpenRetro={openRetro}
                onDeleteRetro={deleteRetro}
                onDecideSuggestion={decideRetroSuggestion}
                onApplyWorkflow={applyRetroWorkflow}
                onCreatePrs={startRetroPrs}
              />
            </Suspense>
          </ChunkErrorBoundary>
        ) : null}
        {bootReady && view === "settings" && settings ? (
          <ChunkErrorBoundary
            key={`settings-${viewAttempts.settings}`}
            view="Settings"
            onRetry={() => retryView("settings")}
          >
            <Suspense fallback={<ViewLoading view="Settings" />}>
              <SettingsFeature
                savedSettings={settings}
                draftRef={settingsDraftRef}
                revisionRef={settingsRevisionRef}
                linearKeyRef={linearKeyDraftRef}
                linearViewer={linearViewer}
                linearViewerLoading={linearViewerLoading}
                linearViewerError={linearViewerError}
                trackerTest={trackerTest}
                skillsStatuses={skillsStatuses}
                skillsChecking={skillsChecking}
                skillsInstall={skillsInstall}
                workflowStatuses={workflowStatuses}
                workflowChecking={workflowChecking}
                workflowTransfer={workflowTransfer}
                settingsDirty={dirty}
                workerRunning={worker.state === "running"}
                workerConfigError={worker.state === "running" && worker.last_error !== null}
                liveReconfigureSkipped={liveReconfigureSkipped}
                activeRunCount={overview.active_runs.length}
                busy={busy}
                runtimeAvailable={runtimeAvailable}
                onDirtyChange={(nextDirty) => {
                  if (settingsDirtyRef.current === nextDirty) return;
                  settingsDirtyRef.current = nextDirty;
                  setSettingsDirty(nextDirty);
                }}
                savePendingRef={settingsSavePendingRef}
                saveControllerRef={settingsSaveControllerRef}
                savePending={settingsSavePending}
                onSavePendingChange={setSettingsSavePending}
                onValidationResult={setValidation}
                onDraftChange={handleSettingsDraftChange}
                onSave={saveSettings}
                onTestConnection={testConnection}
                onRemoveKey={removeLinearKey}
                onResetPrompt={resetPrompt}
                onRefreshSkills={checkRepoSkills}
                onInstallSkills={startSkillsInstall}
                onRefreshWorkflow={checkRepoWorkflow}
                onTransferWorkflow={startWorkflowTransfer}
              />
            </Suspense>
          </ChunkErrorBoundary>
        ) : null}
      </section>
    </main>
  );
}

function ResourceStalenessMonitor({
  resources,
  visibleKeys,
  onStale,
}: {
  resources: DashboardResourceEnvelopes;
  visibleKeys: DashboardResourceKey[];
  onStale: (key: DashboardResourceKey, nowMs: number) => void;
}) {
  const visibleKeySignature = visibleKeys.join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleKeySignature tracks list contents without retriggering for array identity.
  useEffect(() => {
    const timers: number[] = [];
    const now = Date.now();
    visibleKeys.forEach((key) => {
      const resource = resources[key] as DashboardResourceEnvelope<unknown>;
      if (
        resource.data === undefined ||
        resource.dirtySince === null ||
        resourceIsStale(resource) ||
        resource.status === "error"
      ) {
        return;
      }
      const dirtyAt = Date.parse(resource.dirtySince);
      if (!Number.isFinite(dirtyAt)) return;
      const delay = Math.max(0, dirtyAt + 60_000 - now);
      timers.push(window.setTimeout(() => onStale(key, Date.now()), delay));
    });
    return () =>
      timers.forEach((timer) => {
        window.clearTimeout(timer);
      });
  }, [onStale, resources, visibleKeySignature]);

  return null;
}

function ResourceNotices({
  resources,
  resourceKeys,
  slowRefreshingKeys,
  onRetry,
}: {
  resources: DashboardResourceEnvelopes;
  resourceKeys: DashboardResourceKey[];
  slowRefreshingKeys: Set<DashboardResourceKey>;
  onRetry: (key: DashboardResourceKey) => void;
}) {
  const notices = resourceKeys.flatMap((key) => {
    const resource = resources[key] as DashboardResourceEnvelope<unknown>;
    const hasData = hasResourceData(resource);
    const stale = resourceIsStale(resource);
    const noDataFailure = !hasData && resource.error !== null;
    const refreshing = resource.status === "loading" || resource.status === "refreshing";
    const showRefreshing = slowRefreshingKeys.has(key) && refreshing;
    if (!stale && !noDataFailure && !showRefreshing) return [];
    const error = resource.error as DashboardResourceError | null;

    return [
      <section
        key={key}
        className={`resource-notice ${noDataFailure ? "resource-error" : stale ? "resource-stale" : "resource-refreshing"}`}
        role={noDataFailure ? "alert" : undefined}
        aria-busy={refreshing ? "true" : undefined}
      >
        <div className="resource-notice-copy">
          <div className="resource-notice-title">
            <strong>{RESOURCE_LABELS[key]}</strong>
            {stale ? <span className="resource-stale-badge">Stale</span> : null}
            {showRefreshing ? <span className="resource-refreshing-label">Refreshing…</span> : null}
          </div>
          {noDataFailure ? (
            <span>{error?.summary} No data is available.</span>
          ) : stale ? (
            <span>
              Showing the last successful data
              {resource.lastSuccessAt ? (
                <>
                  {" "}
                  from <RelativeTime value={resource.lastSuccessAt} />
                </>
              ) : null}
              .
            </span>
          ) : (
            <span>Fetching the latest data while current content remains visible.</span>
          )}
          {error?.technicalDetails ? (
            <details>
              <summary>Technical details</summary>
              <code>{error.technicalDetails}</code>
            </details>
          ) : null}
        </div>
        {stale || noDataFailure ? (
          <button
            type="button"
            className="secondary"
            disabled={refreshing}
            aria-label={`Retry ${RESOURCE_LABELS[key]}`}
            onClick={() => onRetry(key)}
          >
            Retry
          </button>
        ) : null}
      </section>,
    ];
  });

  return notices.length > 0 ? notices : null;
}

function BootLoading({ preview }: { preview: boolean }) {
  return (
    <div className="boot-surface boot-loading">
      <div className="boot-copy">
        <h2 role="status">{preview ? "Loading preview…" : "Connecting to local worker…"}</h2>
        <p>Please wait.</p>
      </div>
      <div className="boot-skeleton" aria-hidden="true">
        <div className="boot-skeleton-header" />
        <div className="boot-skeleton-kpis">
          <span />
          <span />
          <span />
        </div>
        <div className="boot-skeleton-panels">
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function BootError({
  message,
  onRetry,
  retryButtonRef,
}: {
  message: string;
  onRetry: () => void;
  retryButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="boot-surface boot-error" role="alert">
      <div className="boot-error-panel">
        <div>
          <h2>Couldn’t load Symphony</h2>
          <p>{message}</p>
        </div>
        <button ref={retryButtonRef} type="button" className="primary" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

type SetupState = {
  blocked: boolean;
  linearConnected: boolean;
  repoConfigured: boolean;
};

function OverviewView({
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
  // Use that to pulse streaming rows and show their last-activity heartbeat in
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

+function RunTable({
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
          // biome-ignore lint/a11y/useSemanticElements: a table row cannot be replaced by a button without breaking table semantics.
          <tr
            key={run.id}
            className={run.id === selectedRunId ? "clickable-row selected" : "clickable-row"}
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
            <td>
              <Badge status={run.status} />
            </td>
            <td className="tnum">
              <RelativeTime value={run.created_at} />
            </td>
            {lastActivity ? (
              <td className="tnum">
                {lastActivity.has(run.id) ? (
                  <RelativeTime value={lastActivity.get(run.id) ?? ""} />
                ) : (
                  "—"
                )}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

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
          // biome-ignore lint/a11y/useSemanticElements: a table row cannot be replaced by a button without breaking table semantics.
          <tr
            key={run.id}
            className={run.id === selectedRunId ? "clickable-row selected" : "clickable-row"}
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
            <td>
              <Badge status={run.status} />
            </td>
            <td className="tnum">
              <RelativeTime value={run.created_at} />
            </td>
            {lastActivity ? (
              <td className="tnum">
                {lastActivity.has(run.id) ? (
                  <RelativeTime value={lastActivity.get(run.id) ?? ""} />
                ) : (
                  "—"
                )}
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

function WaveMark() {
  return (
    <svg className="brand-icon" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
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
  if (message.includes("Linear auth failed") || message.includes("Linear HTTP error 401")) {
    return "Linear rejected the request. Update the API key in Settings → Linear.";
  }
  if (message.includes("front matter") || message.includes("tracker configuration")) {
    return `Workflow needs attention: ${message}. Edit it in Settings → Workflow.`;
  }
  return message;
}

function formatError(err: unknown) {
  const message = String(err);
  if (message.includes("invoke") || message.includes("transformCallback")) {
    return "Unable to reach the desktop runtime. Open the Tauri app for live actions.";
  }
  return friendlyError(message);
}

function normalizeBootstrapError(err: unknown) {
  const message = formatError(err)
    .replace(/^Error:\s*/i, "")
    .trim();
  return message || "The desktop runtime did not return startup data.";
}

export default App;
