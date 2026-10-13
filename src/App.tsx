import type { RefObject } from "react";
import { Suspense, useEffect, useRef, useState } from "react";
import { ChunkErrorBoundary, createLazyAttempts, ViewLoading } from "./ChunkBoundary";
import * as desktopCommands from "./desktop/commands";
import { isDesktopRuntime } from "./desktop/runtime";
import { ResourceNotices } from "./features/dashboard/ResourceNotices";
import {
  useDashboardController,
  type DashboardView as View,
} from "./features/dashboard/useDashboardController";
import { useRepositoryReadiness } from "./features/repositories/useRepositoryReadiness";
import { useSettingsController } from "./features/settings/useSettingsController";
import { anyRepoConfigured } from "./features/shared/configuration";
import { formatError, friendlyError } from "./features/shared/errors";
import { useDesktopActions } from "./features/shared/useDesktopActions";
import { shortTime } from "./format";
import type { PollResourceState } from "./pollController";
import type { IssueViewMode } from "./views/IssuesView";
import { OverviewView } from "./views/OverviewView";
import "./App.css";

export { loadDashboardSnapshot } from "./features/dashboard/useDashboardController";

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

function App() {
  const runtimeAvailable = isDesktopRuntime();
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<View>("overview");
  const [issuesViewMode, setIssuesViewMode] = useState<IssueViewMode>("dependencies");
  const [viewAttempts, setViewAttempts] = useState<Record<Exclude<View, "overview">, number>>({
    runs: 0,
    issues: 0,
    retro: 0,
    settings: 0,
  });
  const actions = useDesktopActions(runtimeAvailable);
  const { busy, error, reportError: setError, setInstallLocked } = actions;
  const settingsFeature = useSettingsController({
    runtimeAvailable,
    run: actions.run,
    acceptWorker: (status): void => dashboard.acceptWorker(status),
    readWorkerStatus: (): import("./bindings").WorkerStatus => dashboard.data.worker,
    refreshRepositories: (target): void => repositories.queueRefresh(target),
  });
  const repositories = useRepositoryReadiness({
    runtimeAvailable,
    visible: view === "settings",
    settings: settingsFeature.saved,
    readDraft: settingsFeature.session.readDraft,
    run: actions.run,
  });
  const dashboard = useDashboardController({
    runtimeAvailable,
    view,
    settings: settingsFeature.saved,
    navigate: setView,
    run: actions.run,
    reportError: setError,
    acceptSettings: settingsFeature.acceptSaved,
    initializeRepositories: repositories.initializePreview,
    invalidateWorkflow: repositories.invalidateWorkflow,
  });
  const {
    saved: settings,
    dirty,
    savePending: settingsSavePending,
    validation,
    savedFlash,
    runtimeUpdateError,
    savedLiveConfigKept,
  } = settingsFeature;
  const {
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
  } = dashboard.data;
  const {
    dashboardResources,
    panelResourceKeys,
    resourceAnnouncement,
    slowRefreshingKeys,
    retry: retryDashboardResource,
  } = dashboard.resources;
  const {
    state: bootState,
    settled: bootstrapSettled,
    retry: retryBootstrap,
  } = dashboard.bootstrap;
  const {
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
  } = dashboard.commands;
  const {
    manualUpdateCheckRequest,
    acceptWorker: setWorker,
    acceptOverview: setOverview,
    acceptRetroBatchWork: setHasInProgressRetroBatches,
  } = dashboard;
  const { skillsInstall, workflowTransfer } = repositories.state;
  const pollingStates = { ...dashboard.pollingStates, ...repositories.pollingStates };
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmStopTimer = useRef<number | null>(null);
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

  useEffect(() => {
    if (!runtimeAvailable) return;

    if (bootState.status === "error") retryButtonRef.current?.focus();
  }, [bootState.status, runtimeAvailable]);

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
  const AppUpdateComponent = useDeferredUpdater(runtimeAvailable && !IS_LOCAL_DEV);
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
            {AppUpdateComponent ? (
              <AppUpdateComponent
                manualCheckRequest={manualUpdateCheckRequest}
                overview={overview}
                backgroundWork={updateBackgroundWork}
                hasInProgressRetroBatches={hasInProgressRetroBatches}
                hasUnsavedSettings={dirty}
                settingsDraft={settingsFeature.session.readDraft()}
                pendingLinearKey={settingsFeature.session.readKey()}
                transientBusy={busy}
                onWorkerChange={setWorker}
                onOverviewChange={setOverview}
                onRetroBatchWorkChange={setHasInProgressRetroBatches}
                onInstallLockChange={setInstallLocked}
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
                  runtimeUpdateError={runtimeUpdateError}
                  liveReconfigureSkipped={savedLiveConfigKept}
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
                stateOrder={
                  settings ? [...settings.active_states, ...settings.terminal_states] : undefined
                }
                loadWorkflowStates={
                  runtimeAvailable ? desktopCommands.listWorkflowStates : undefined
                }
                onMoveIssue={runtimeAvailable ? desktopCommands.setIssueState : undefined}
                loadBoardIssues={runtimeAvailable ? desktopCommands.listBoardIssues : undefined}
                activeRunIssueIds={activeRunIssueIds}
                activeStates={settings?.active_states ?? undefined}
                initialMode={issuesViewMode}
                onModeChange={setIssuesViewMode}
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
                controller={settingsFeature}
                repositories={repositories}
                worker={worker}
                activeRunCount={overview.active_runs.length}
                busy={busy}
                runtimeAvailable={runtimeAvailable}
              />
            </Suspense>
          </ChunkErrorBoundary>
        ) : null}
      </section>
    </main>
  );
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

export default App;
