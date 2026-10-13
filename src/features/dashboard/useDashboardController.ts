import type { SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  DashboardOverview,
  IssueSummary,
  RepoWorkflowStatus,
  RetroDetail,
  RetroStatus,
  RetroSummary,
  RunDetail,
  RunSummary,
  SkillsStatus,
  SuggestionDecision,
  WorkerStatus,
} from "../../bindings";
import {
  createDashboardRefreshCoordinator,
  type DashboardRefreshContext,
  type DashboardRefreshCoordinator,
} from "../../dashboardRefreshCoordinator";
import {
  beginResourceRefresh,
  completeResourceRefresh,
  createResourceEnvelope,
  type DashboardResourceEnvelope,
  failResourceRefresh,
  hasResourceData,
  markResourceDirty as markEnvelopeDirty,
  normalizeResourceError,
  resourceIsStale,
  staleDirtyResource,
} from "../../dashboardResourceState";
import {
  type DashboardResourceKey,
  resourcesForDbChange,
  resourcesForView,
  visibleResources,
} from "../../dashboardResources";
import * as desktopCommands from "../../desktop/commands";
import { subscribeDesktopEvents } from "../../desktop/events";
import { createPollController, type PollController } from "../../pollController";
import { anyRepoConfigured } from "../shared/configuration";
import { formatError, normalizeBootstrapError } from "../shared/errors";
import type { RunDesktopAction } from "../shared/useDesktopActions";
import { usePollingStatus } from "../shared/usePollingStatus";
export type DashboardView = "overview" | "runs" | "issues" | "retro" | "settings";
type View = DashboardView;
type PollKey = "worker" | "retro";
const DASHBOARD_COMMAND_TRACE_ENABLED = import.meta.env.DEV && import.meta.env.MODE !== "test";
const loadPreviewRuntime = () => import("../../preview/runtime");
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

const emptyOverview: DashboardOverview = {
  active_runs: [],
  retry_queue: [],
  retry_count: 0,
  recent_failures: [],
  workspace_cleanup_count: 0,
  live_sessions: [],
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

type DashboardSnapshot = {
  overview: DashboardOverview;
  runs: RunSummary[];
  issues: IssueSummary[];
  worker: WorkerStatus;
  retroStatus: RetroStatus;
  retros: RetroSummary[];
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
  retros: RetroSummary[];
};

type DashboardResourceData = {
  overview: DashboardOverview;
  runs: RunSummary[];
  issues: IssueSummary[];
  worker: WorkerStatus;
  retroList: RetroListResource;
  retroBatches: boolean;
  selectedRun: RunDetail | null;
  selectedRetro: RetroDetail | null;
};

export type DashboardResourceEnvelopes = {
  [Key in DashboardResourceKey]: DashboardResourceEnvelope<DashboardResourceData[Key]>;
};

export const RESOURCE_LABELS: Record<DashboardResourceKey, string> = {
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
    overview: createResourceEnvelope<DashboardOverview>(),
    runs: createResourceEnvelope<RunSummary[]>(),
    issues: createResourceEnvelope<IssueSummary[]>(),
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

function retroRowRenderedFields(row: RetroSummary) {
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

type Options = {
  runtimeAvailable: boolean;
  view: DashboardView;
  settings: AppSettings | null;
  navigate: (view: DashboardView) => void;
  run: RunDesktopAction;
  reportError: (error: string | null) => void;
  acceptSettings: (settings: AppSettings) => void;
  initializeRepositories: (preview: {
    skillsStatuses: Record<string, SkillsStatus>;
    workflowStatuses: Record<string, RepoWorkflowStatus>;
  }) => void;
  invalidateWorkflow: () => void;
};
export function useDashboardController(options: Options) {
  const {
    runtimeAvailable,
    view,
    settings,
    navigate: setView,
    run: call,
    reportError: setError,
  } = options;
  const context = useRef(options);
  context.current = options;
  const { pollingStates, updatePollingState, clearPollingState } = usePollingStatus<PollKey>();
  const [dashboardResources, setDashboardResources] = useState<DashboardResourceEnvelopes>(
    createInitialDashboardResources,
  );
  const overview = dashboardResources.overview.data ?? emptyOverview;
  const runs = dashboardResources.runs.data ?? [];
  const issues = dashboardResources.issues.data ?? [];
  // overview refreshes on the Issues view too (run-table changes invalidate it, and
  // overview is always "visible"), but with debounce/IPC latency — so this is a
  // best-effort convenience guard, not an authoritative check.
  const activeRunIssueIds = useMemo(
    () => overview.active_runs.map((run) => run.issue_id),
    [overview.active_runs],
  );
  const retros = dashboardResources.retroList.data?.retros ?? [];
  const retroStatus = dashboardResources.retroList.data?.retroStatus ?? emptyRetroStatus;
  const worker = dashboardResources.worker.data ?? {
    state: "stopped",
    started_at: null,
    last_error: null,
  };
  const selectedRun = dashboardResources.selectedRun.data ?? null;
  const selectedRetro = dashboardResources.selectedRetro.data ?? null;
  const [manualUpdateCheckRequest, setManualUpdateCheckRequest] = useState(0);
  const [resourceAnnouncement, setResourceAnnouncement] =
    useState<ResourceFailureAnnouncement | null>(null);
  const [slowRefreshingKeys, setSlowRefreshingKeys] = useState<Set<DashboardResourceKey>>(
    () => new Set(),
  );
  const [bootState, setBootState] = useState<BootState>({ status: "loading" });
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrapSettled, setBootstrapSettled] = useState(false);
  const hasInProgressRetroBatches = dashboardResources.retroBatches.data ?? false;
  const [stoppingRunIds, setStoppingRunIds] = useState<Set<string>>(() => new Set());
  const [triggeringRetryIds, setTriggeringRetryIds] = useState<Set<string>>(() => new Set());
  const selectedRunIdRef = useRef<string | null>(null);
  const selectedRetroIdRef = useRef<string | null>(null);
  const previewRuntimeRef = useRef<typeof import("../../preview/runtime")["previewRuntime"] | null>(
    null,
  );
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  const dirtyResourcesRef = useRef<Set<DashboardResourceKey>>(new Set());
  const dirtyResourceVersionsRef = useRef<Partial<Record<DashboardResourceKey, number>>>({});
  const selectedRunRef = useRef<RunDetail | null>(selectedRun);
  selectedRunRef.current = selectedRun;
  const typedAgentEventAwaitingDbChangeRef = useRef(false);
  const localAppendVersionRef = useRef(0);
  const resourceCommandCounts = useRef<Record<string, number>>({});
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

  const setOverview = (update: SetStateAction<DashboardOverview>) =>
    setResourceData("overview", update);
  const setRuns = (update: SetStateAction<RunSummary[]>) => setResourceData("runs", update);
  const setWorker = (update: SetStateAction<WorkerStatus>) => setResourceData("worker", update);
  const setRetroStatus = (update: SetStateAction<RetroStatus>) =>
    setResourceData("retroList", (current) => ({
      ...current,
      retroStatus: typeof update === "function" ? update(current.retroStatus) : update,
    }));
  const setRetros = (update: SetStateAction<RetroSummary[]>) =>
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
                const updateRunIssue = (run: RunSummary): RunSummary => {
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrapAttempt is an explicit retry trigger; snapshot commit reads current refs.
  useEffect(() => {
    if (runtimeAvailable) return;
    let cancelled = false;
    loadPreviewRuntime()
      .then(({ previewRuntime }) => {
        if (cancelled) return;
        previewRuntimeRef.current = previewRuntime;
        context.current.acceptSettings(previewRuntime.settings);
        context.current.initializeRepositories(previewRuntime);
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
        context.current.acceptSettings(loaded);
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
      onWorkflowReady: () => {
        context.current.invalidateWorkflow();
      },
      onCheckForUpdates: () => {
        setManualUpdateCheckRequest((request) => request + 1);
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

  useEffect(() => {
    if (!runtimeAvailable || bootState.status !== "ready") return;
    const viewKeys = resourcesForView(view).filter((key) => dirtyResourcesRef.current.has(key));
    void requestInvalidatedResources(viewKeys, { reportFailure: true }, false);
  }, [bootState.status, requestInvalidatedResources, runtimeAvailable, view]);

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
        const preview = previewRuntimeRef.current;
        if (!preview) return;
        const current = dashboardResourcesRef.current;
        const updated = preview.cancelRun(id, {
          runs: current.runs.data ?? [],
          overview: current.overview.data ?? emptyOverview,
          selectedRun: current.selectedRun.data ?? null,
        });
        setRuns(updated.runs);
        setOverview(updated.overview);
        setSelectedRun(updated.selectedRun);
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

  async function decideRetroSuggestion(id: string, decision: SuggestionDecision) {
    if (!runtimeAvailable) {
      const preview = previewRuntimeRef.current;
      if (preview) setSelectedRetro((current) => preview.decideSuggestion(current, id, decision));
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
    context.current.acceptSettings(saved);
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
          | { retroStatus: RetroStatus; retros: RetroSummary[] }
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
          | { retroStatus: RetroStatus; retros: RetroSummary[] }
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

  const visibleDashboardResourceKeys = visibleResources(
    DASHBOARD_RESOURCE_KEYS,
    view,
    selectedRunIdRef.current,
    selectedRetroIdRef.current,
  );
  const panelResourceKeys = resourcesForView(view).filter((key) =>
    visibleDashboardResourceKeys.includes(key),
  );
  const visibleKeySignature = visibleDashboardResourceKeys.join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleKeySignature tracks list contents without retriggering for array identity.
  useEffect(() => {
    const timers: number[] = [];
    const now = Date.now();
    visibleDashboardResourceKeys.forEach((key) => {
      const resource = dashboardResources[key] as DashboardResourceEnvelope<unknown>;
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
      timers.push(window.setTimeout(() => markVisibleResourceStale(key, Date.now()), delay));
    });
    return () =>
      timers.forEach((timer) => {
        window.clearTimeout(timer);
      });
  }, [markVisibleResourceStale, dashboardResources, visibleKeySignature]);

  return {
    data: {
      overview,
      runs,
      issues,
      worker,
      retros,
      retroStatus,
      selectedRun,
      selectedRetro,
      activeRunIds,
      activeRunIssueIds,
      multiRepo,
      hasInProgressRetroBatches,
      stoppingRunIds,
      triggeringRetryIds,
    },
    resources: {
      dashboardResources,
      panelResourceKeys,
      resourceAnnouncement,
      slowRefreshingKeys,
      retry: retryDashboardResource,
    },
    bootstrap: { state: bootState, settled: bootstrapSettled, retry: retryBootstrap },
    pollingStates,
    manualUpdateCheckRequest,
    commands: {
      startWorker,
      stopWorker,
      openRun,
      stopRun,
      triggerRetryNow,
      startRetro,
      openRetro,
      deleteRetro,
      decideRetroSuggestion,
      applyRetroWorkflow,
      startRetroPrs,
      refreshDashboard,
    },
    acceptWorker: setWorker,
    acceptOverview: setOverview,
    acceptRetroBatchWork: setHasInProgressRetroBatches,
  };
}
export type DashboardController = ReturnType<typeof useDashboardController>;
