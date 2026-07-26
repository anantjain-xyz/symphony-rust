import { useEffect, useRef, useState } from "react";
import type { AppUpdateProps, UpdateSafety } from "./appUpdateTypes";
import type { AppSettings, Overview, WorkerStatus } from "./bindings";
import { desktopCommands } from "./desktop/commands";
import {
  checkForDesktopUpdate,
  relaunchDesktopApp,
  type DesktopDownloadEvent,
  type DesktopUpdate,
} from "./desktop/updater";
import "./AppUpdate.css";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type AppUpdateFeatureProps = {
  overview: Overview;
  backgroundWork: string[];
  hasInProgressRetroBatches: boolean;
  hasUnsavedSettings: boolean;
  settingsDraft: AppSettings | null;
  pendingLinearKey: string;
  transientBusy: boolean;
  onWorkerChange: (worker: WorkerStatus) => void;
  onOverviewChange: (overview: Overview) => void;
  onRetroBatchWorkChange: (active: boolean) => void;
  onInstallLockChange: (locked: boolean) => void;
  onActionError: (message: string) => void;
};

function localValueFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function settingsFingerprint(settings: AppSettings, linearKey: string) {
  const { linear_api_key_set: _ignored, ...form } = settings;
  return JSON.stringify({
    settings: JSON.stringify(form),
    pendingLinearKey: localValueFingerprint(linearKey),
  });
}

export function AppUpdateFeature(props: AppUpdateFeatureProps) {
  async function prepareForInstall() {
    const [installWorker, installOverview] = await Promise.all([
      desktopCommands.getWorkerStatus(),
      desktopCommands.getOverview(),
    ]);
    props.onWorkerChange(installWorker);
    props.onOverviewChange(installOverview);
    const workerWasRunning = installWorker.state === "running";
    const restoreWorker = async () => {
      if (!workerWasRunning) return;
      const status = await desktopCommands.getWorkerStatus();
      if (status.state === "stopped") {
        props.onWorkerChange(await desktopCommands.startWorker());
      }
    };
    const restoreWorkerWhenStopped = async () => {
      if (!workerWasRunning) return;
      for (;;) {
        try {
          const status = await desktopCommands.getWorkerStatus();
          props.onWorkerChange(status);
          if (status.state === "stopped") {
            await restoreWorker();
            return;
          }
        } catch {
          // Keep trying after a transient read/start failure during restoration.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    };

    if (installWorker.state !== "stopped") {
      props.onWorkerChange(await desktopCommands.stopWorker());
      try {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const [nextWorker, nextOverview] = await Promise.all([
            desktopCommands.getWorkerStatus(),
            desktopCommands.getOverview(),
          ]);
          props.onWorkerChange(nextWorker);
          props.onOverviewChange(nextOverview);
          if (nextWorker.state === "stopped" && nextOverview.active_runs.length === 0) {
            return restoreWorker;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      } catch (error) {
        void restoreWorkerWhenStopped().catch(() => undefined);
        throw error;
      }
      void restoreWorkerWhenStopped().catch(() => undefined);
      throw new Error("Symphony could not stop active work safely within 30 seconds.");
    }
    return restoreWorker;
  }

  async function verifyInstallSafety(): Promise<UpdateSafety> {
    const [nextOverview, nextHasRetroBatches] = await Promise.all([
      desktopCommands.getOverview(),
      desktopCommands.hasInProgressRetroBatches(),
    ]);
    props.onOverviewChange(nextOverview);
    props.onRetroBatchWorkChange(nextHasRetroBatches);
    return {
      activeRunCount: nextOverview.active_runs.length,
      activeRunIds: nextOverview.active_runs.map((run) => run.id),
      backgroundWork: [
        ...props.backgroundWork.filter((item) => item !== "an active Retro change batch"),
        ...(nextHasRetroBatches ? ["an active Retro change batch"] : []),
      ],
      hasUnsavedSettings: props.hasUnsavedSettings,
      settingsFingerprint:
        props.hasUnsavedSettings && props.settingsDraft
          ? settingsFingerprint(props.settingsDraft, props.pendingLinearKey)
          : null,
      transientBusy: props.transientBusy,
    };
  }

  return (
    <AppUpdate
      enabled
      safety={{
        activeRunCount: props.overview.active_runs.length,
        activeRunIds: props.overview.active_runs.map((run) => run.id),
        backgroundWork: props.backgroundWork,
        hasUnsavedSettings: props.hasUnsavedSettings,
        settingsFingerprint:
          props.hasUnsavedSettings && props.settingsDraft
            ? settingsFingerprint(props.settingsDraft, props.pendingLinearKey)
            : null,
        transientBusy: props.transientBusy,
      }}
      verifyInstallSafety={verifyInstallSafety}
      prepareForInstall={prepareForInstall}
      onInstallLockChange={props.onInstallLockChange}
      onActionError={props.onActionError}
    />
  );
}

const geometryPreviewSafety: UpdateSafety = {
  activeRunCount: 0,
  activeRunIds: [],
  backgroundWork: [],
  hasUnsavedSettings: false,
  settingsFingerprint: null,
  transientBusy: false,
};

const geometryPreviewUpdate = {
  version: "preview",
  close: async () => undefined,
  download: async () => undefined,
  install: async () => undefined,
} as unknown as DesktopUpdate;

const resolveGeometryPreviewUpdate = async () => geometryPreviewUpdate;

export function AppUpdateGeometryPreview() {
  return (
    <main className="app" data-preview-fixture="updater-geometry">
      <header className="topbar">
        <div className="brand">
          <h1>Updater geometry</h1>
          <AppUpdate
            enabled
            safety={geometryPreviewSafety}
            checkForUpdate={resolveGeometryPreviewUpdate}
            prepareForInstall={async () => async () => undefined}
            onActionError={() => undefined}
          />
        </div>
      </header>
    </main>
  );
}

type UpdatePhase =
  | "hidden"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "restarting"
  | "restart-required";

type ConfirmationStage = "start" | "install" | "restart";

function hasUnsafeWork(safety: UpdateSafety) {
  return (
    safety.activeRunCount > 0 ||
    safety.backgroundWork.length > 0 ||
    safety.hasUnsavedSettings
  );
}

function safetyFingerprint(safety: UpdateSafety) {
  return JSON.stringify({
    activeRunIds: [...safety.activeRunIds].sort(),
    backgroundWork: [...safety.backgroundWork].sort(),
    settingsFingerprint: safety.hasUnsavedSettings
      ? safety.settingsFingerprint
      : null,
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function AppUpdate({
  enabled,
  safety,
  verifyInstallSafety,
  prepareForInstall,
  onInstallLockChange,
  onActionError,
  checkForUpdate = checkForDesktopUpdate,
  relaunchApp = relaunchDesktopApp,
}: AppUpdateProps & {
  checkForUpdate?: () => Promise<DesktopUpdate | null>;
  relaunchApp?: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<UpdatePhase>("hidden");
  const [candidate, setCandidate] = useState<DesktopUpdate | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationStage | null>(null);
  const [confirmationSafety, setConfirmationSafety] = useState<UpdateSafety | null>(null);
  const candidateRef = useRef<DesktopUpdate | null>(null);
  const checkingRef = useRef(false);
  const approvedSafetyRef = useRef<string | null>(null);
  const safetyRef = useRef(safety);
  const prepareForInstallRef = useRef(prepareForInstall);
  const verifyInstallSafetyRef = useRef<() => Promise<UpdateSafety>>(
    verifyInstallSafety ?? (async () => safety),
  );
  const onInstallLockChangeRef = useRef<(locked: boolean) => void>(
    onInstallLockChange ?? (() => undefined),
  );
  const onActionErrorRef = useRef(onActionError);
  const updateButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  safetyRef.current = safety;
  prepareForInstallRef.current = prepareForInstall;
  verifyInstallSafetyRef.current =
    verifyInstallSafety ?? (async () => safetyRef.current);
  onInstallLockChangeRef.current = onInstallLockChange ?? (() => undefined);
  onActionErrorRef.current = onActionError;

  useEffect(() => {
    candidateRef.current = candidate;
  }, [candidate]);

  useEffect(() => {
    if (!confirmation) return;
    cancelButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConfirmation(null);
      } else if (event.key === "Tab") {
        const buttons = Array.from(
          dialogRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        );
        if (buttons.length === 0) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      updateButtonRef.current?.focus();
    };
  }, [confirmation]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refreshAvailableUpdate = async () => {
      if (checkingRef.current || candidateRef.current) return;
      checkingRef.current = true;
      try {
        const update = await checkForUpdate();
        if (cancelled) {
          await update?.close().catch(() => undefined);
          return;
        }
        if (update) {
          candidateRef.current = update;
          setCandidate(update);
          setPhase("available");
        } else {
          setPhase("hidden");
        }
      } catch (error) {
        // Update awareness is opportunistic: offline or malformed-feed failures
        // must not distract from the worker. The next scheduled check retries.
        console.warn("Symphony update check failed", error);
      } finally {
        checkingRef.current = false;
      }
    };

    void refreshAvailableUpdate();
    const interval = window.setInterval(
      refreshAvailableUpdate,
      UPDATE_CHECK_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [checkForUpdate, enabled]);

  useEffect(
    () => () => {
      void candidateRef.current?.close().catch(() => undefined);
    },
    [],
  );

  if (!enabled || phase === "hidden" || !candidate) return null;

  const requestStart = () => {
    if (safety.transientBusy) return;
    approvedSafetyRef.current = null;
    if (hasUnsafeWork(safety)) {
      setConfirmationSafety(safety);
      setConfirmation(phase === "ready" ? "install" : "start");
      return;
    }
    if (phase === "ready") {
      void requestInstall();
    } else {
      void download();
    }
  };

  const confirmUpdate = () => {
    const stage = confirmation;
    approvedSafetyRef.current = safetyFingerprint(
      confirmationSafety ?? safetyRef.current,
    );
    setConfirmation(null);
    setConfirmationSafety(null);
    if (stage === "start") {
      void download();
    } else if (stage === "install") {
      void requestInstall();
    } else if (stage === "restart") {
      void restartInstalledUpdate();
    }
  };

  const download = async () => {
    setPhase("downloading");
    setProgress(null);
    let downloaded = 0;
    let contentLength: number | undefined;
    try {
      await candidate.download((event: DesktopDownloadEvent) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength;
          setProgress(contentLength === 0 ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength && contentLength > 0) {
            setProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          }
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setPhase("ready");
      if (safetyRef.current.transientBusy) return;
      await requestInstall();
    } catch (error) {
      setPhase("available");
      setProgress(null);
      onActionErrorRef.current(`Update download failed: ${errorMessage(error)}`);
    }
  };

  const requestInstall = async () => {
    try {
      const verifiedSafety = await verifyInstallSafetyRef.current();
      safetyRef.current = verifiedSafety;
      if (verifiedSafety.transientBusy) {
        setPhase("ready");
        return;
      }
      if (
        hasUnsafeWork(verifiedSafety) &&
        safetyFingerprint(verifiedSafety) !== approvedSafetyRef.current
      ) {
        setConfirmationSafety(verifiedSafety);
        setConfirmation("install");
        setPhase("ready");
        return;
      }
      await installAndRestart();
    } catch (error) {
      setPhase("ready");
      onActionErrorRef.current(
        `Could not verify update safety: ${errorMessage(error)}`,
      );
    }
  };

  const installAndRestart = async () => {
    let restoreWorker: (() => Promise<void>) | null = null;
    try {
      setPhase("installing");
      onInstallLockChangeRef.current(true);
      restoreWorker = await prepareForInstallRef.current();
      await candidate.install();
    } catch (error) {
      await restoreWorker?.().catch(() => undefined);
      onInstallLockChangeRef.current(false);
      setPhase("ready");
      onActionErrorRef.current(`Update installation failed: ${errorMessage(error)}`);
      return;
    }

    try {
      setPhase("restarting");
      await relaunchApp();
    } catch (error) {
      await restoreWorker?.().catch(() => undefined);
      onInstallLockChangeRef.current(false);
      setPhase("restart-required");
      onActionErrorRef.current(
        `The update was installed, but Symphony could not restart: ${errorMessage(error)}`,
      );
    }
  };

  const restartInstalledUpdate = async () => {
    let restoreWorker: (() => Promise<void>) | null = null;
    try {
      setPhase("restarting");
      onInstallLockChangeRef.current(true);
      restoreWorker = await prepareForInstallRef.current();
      await relaunchApp();
    } catch (error) {
      await restoreWorker?.().catch(() => undefined);
      onInstallLockChangeRef.current(false);
      setPhase("restart-required");
      onActionErrorRef.current(`Symphony could not restart: ${errorMessage(error)}`);
    }
  };

  const requestRestart = () => {
    if (safety.transientBusy) return;
    approvedSafetyRef.current = null;
    if (hasUnsafeWork(safety)) {
      setConfirmationSafety(safety);
      setConfirmation("restart");
      return;
    }
    void restartInstalledUpdate();
  };

  const working = ["downloading", "installing", "restarting"].includes(phase);
  const buttonLabel =
    phase === "downloading"
      ? progress === null
        ? "Downloading…"
        : `Downloading ${progress}%`
      : phase === "ready"
        ? "Update"
        : phase === "installing"
          ? "Installing…"
          : phase === "restarting"
            ? "Restarting…"
            : phase === "restart-required"
              ? "Restart"
              : "Update";
  const title = safety.transientBusy
    ? "Finish the current action before updating Symphony"
    : phase === "restart-required"
      ? `Restart to finish updating Symphony to v${candidate.version}`
      : `Update Symphony to v${candidate.version}`;

  return (
    <>
      <button
        ref={updateButtonRef}
        type="button"
        className={`update-button ${phase}${phase !== "available" ? " expanded" : ""}`}
        disabled={working || safety.transientBusy}
        onClick={phase === "restart-required" ? requestRestart : requestStart}
        title={title}
        aria-label={title}
        aria-live="polite"
      >
        <span className="update-button-icon-slot">
          {working ? <UpdateSpinner /> : <UpdateIcon />}
        </span>
        <span className="update-button-label">{buttonLabel}</span>
      </button>

      {confirmation ? (
        <div
          className="update-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setConfirmation(null);
          }}
        >
          <section
            ref={dialogRef}
            className="update-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="update-dialog-title"
            aria-describedby="update-dialog-description"
          >
            <h2 id="update-dialog-title">Update and restart Symphony?</h2>
            <p id="update-dialog-description">
              {safetyDescription(confirmationSafety ?? safety)}
            </p>
            <div className="update-dialog-actions">
              <button
                ref={cancelButtonRef}
                type="button"
                onClick={() => setConfirmation(null)}
              >
                Not now
              </button>
              <button type="button" className="primary" onClick={confirmUpdate}>
                {confirmation === "restart" ? "Restart Symphony" : "Update & Restart"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function safetyDescription(safety: UpdateSafety) {
  const warnings: string[] = [];
  if (safety.activeRunCount > 0) {
    warnings.push(
      `${safety.activeRunCount} active ${safety.activeRunCount === 1 ? "run" : "runs"} will be interrupted`,
    );
  }
  warnings.push(...safety.backgroundWork.map((work) => `${work} will be interrupted`));
  if (safety.hasUnsavedSettings) warnings.push("unsaved Settings changes will be lost");
  return `Updating restarts Symphony. ${warnings.join("; ")}.`;
}

function UpdateIcon() {
  return (
    <svg
      className="update-button-icon"
      viewBox="-1.333333 -1.333333 26.666666 26.666666"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function UpdateSpinner() {
  return <span className="update-spinner" aria-hidden="true" />;
}
