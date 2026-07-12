import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type UpdatePhase =
  | "hidden"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "restarting"
  | "restart-required";

type ConfirmationStage = "start" | "install" | "restart";

export type UpdateSafety = {
  activeRunCount: number;
  backgroundWork: string[];
  hasUnsavedSettings: boolean;
  transientBusy: boolean;
};

type AppUpdateProps = {
  enabled: boolean;
  safety: UpdateSafety;
  prepareForInstall: () => Promise<() => Promise<void>>;
  onActionError: (message: string) => void;
};

function hasUnsafeWork(safety: UpdateSafety) {
  return (
    safety.activeRunCount > 0 ||
    safety.backgroundWork.length > 0 ||
    safety.hasUnsavedSettings
  );
}

function safetyFingerprint(safety: UpdateSafety) {
  return JSON.stringify({
    activeRunCount: safety.activeRunCount,
    backgroundWork: [...safety.backgroundWork].sort(),
    hasUnsavedSettings: safety.hasUnsavedSettings,
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
  prepareForInstall,
  onActionError,
}: AppUpdateProps) {
  const [phase, setPhase] = useState<UpdatePhase>("hidden");
  const [candidate, setCandidate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationStage | null>(null);
  const candidateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const approvedSafetyRef = useRef<string | null>(null);
  const safetyRef = useRef(safety);
  const prepareForInstallRef = useRef(prepareForInstall);
  const onActionErrorRef = useRef(onActionError);
  const updateButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  safetyRef.current = safety;
  prepareForInstallRef.current = prepareForInstall;
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

    const checkForUpdate = async () => {
      if (checkingRef.current || candidateRef.current) return;
      checkingRef.current = true;
      try {
        const update = await check();
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

    void checkForUpdate();
    const interval = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled]);

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
      setConfirmation(phase === "ready" ? "install" : "start");
      return;
    }
    if (phase === "ready") {
      void installAndRestart();
    } else {
      void download();
    }
  };

  const confirmUpdate = () => {
    const stage = confirmation;
    approvedSafetyRef.current = safetyFingerprint(safetyRef.current);
    setConfirmation(null);
    if (stage === "start") {
      void download();
    } else if (stage === "install") {
      void installAndRestart();
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
      await candidate.download((event: DownloadEvent) => {
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
      if (
        hasUnsafeWork(safetyRef.current) &&
        safetyFingerprint(safetyRef.current) !== approvedSafetyRef.current
      ) {
        setConfirmation("install");
        return;
      }
      await installAndRestart();
    } catch (error) {
      setPhase("available");
      setProgress(null);
      onActionErrorRef.current(`Update download failed: ${errorMessage(error)}`);
    }
  };

  const installAndRestart = async () => {
    let restoreWorker: (() => Promise<void>) | null = null;
    try {
      setPhase("installing");
      restoreWorker = await prepareForInstallRef.current();
      await candidate.install();
    } catch (error) {
      await restoreWorker?.().catch(() => undefined);
      setPhase("ready");
      onActionErrorRef.current(`Update installation failed: ${errorMessage(error)}`);
      return;
    }

    try {
      setPhase("restarting");
      await relaunch();
    } catch (error) {
      await restoreWorker?.().catch(() => undefined);
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
      restoreWorker = await prepareForInstallRef.current();
      await relaunch();
    } catch (error) {
      await restoreWorker?.().catch(() => undefined);
      setPhase("restart-required");
      onActionErrorRef.current(`Symphony could not restart: ${errorMessage(error)}`);
    }
  };

  const requestRestart = () => {
    if (safety.transientBusy) return;
    approvedSafetyRef.current = null;
    if (hasUnsafeWork(safety)) {
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
        {working ? <UpdateSpinner /> : <UpdateIcon />}
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
            <p id="update-dialog-description">{safetyDescription(safety)}</p>
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
      viewBox="0 0 24 24"
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
