import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  LinearViewerProfile,
  TrackerTestResult,
  ValidationResult,
  WorkerStatus,
} from "../../bindings";
import * as desktopCommands from "../../desktop/commands";
import { formSnapshot } from "../../viewPrimitives";
import { configuredRepoUrls, stableSessionEnvKey } from "../shared/configuration";
import { formatError } from "../shared/errors";
import type { RunDesktopAction } from "../shared/useDesktopActions";
import { createSettingsSession } from "./settingsSession";

type Options = {
  runtimeAvailable: boolean;
  run: RunDesktopAction;
  acceptWorker: (status: WorkerStatus) => void;
  readWorkerState: () => WorkerStatus["state"];
  refreshRepositories: (settings: AppSettings) => void;
};
export function useSettingsController(options: Options) {
  const { runtimeAvailable, run: call } = options;
  const context = useRef(options);
  context.current = options;
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [session] = useState(() => createSettingsSession(setDirty, setSavePending));
  const [linearViewer, setLinearViewer] = useState<LinearViewerProfile | null>(null);
  const [linearViewerLoading, setLinearViewerLoading] = useState(false);
  const [linearViewerError, setLinearViewerError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [savedLiveConfigKept, setSavedLiveConfigKept] = useState(false);
  const [trackerTest, setTrackerTest] = useState<TrackerTestResult | null>(null);
  const savedFlashTimer = useRef<number | null>(null);
  const linearViewerSeq = useRef(0);
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
    if (settings) refreshLinearViewer(settings, session.readKey());
  }, [refreshLinearViewer, settings, session]);

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
        context.current.refreshRepositories(next);
      }
    },
    [refreshLinearViewer],
  );

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
      context.current.acceptWorker(refreshedWorker);
    } catch {
      // Settings are saved even if this status refresh fails; the next dashboard
      // refresh will reconcile worker state.
    }
    const liveWorkerState = refreshedWorker?.state ?? context.current.readWorkerState();
    setSavedLiveConfigKept(
      liveWorkerState === "running" &&
        (!result.workflow_ok || refreshedWorker?.last_error !== null),
    );
    const currentDraft = session.readDraft();
    const refreshTarget =
      currentDraft && formSnapshot(currentDraft) !== formSnapshot(exactSettings)
        ? currentDraft
        : saved;
    context.current.refreshRepositories(refreshTarget);
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

  async function removeLinearKey() {
    const fromDisk = await call(desktopCommands.removeLinearApiKey);
    setSettings((current) =>
      current
        ? {
            ...current,
            settings_revision: fromDisk.settings_revision,
            linear_api_key_set: fromDisk.linear_api_key_set,
          }
        : current,
    );
    session.replaceKey("");
    setTrackerTest(null);
    return fromDisk.linear_api_key_set;
  }

  async function resetPrompt() {
    return call(desktopCommands.getDefaultPrompt);
  }

  useEffect(
    () => () => {
      linearViewerSeq.current += 1;
      if (savedFlashTimer.current !== null) window.clearTimeout(savedFlashTimer.current);
    },
    [],
  );
  return {
    saved: settings,
    dirty,
    savePending,
    validation,
    savedFlash,
    savedLiveConfigKept,
    viewer: { linearViewer, linearViewerLoading, linearViewerError, trackerTest },
    session,
    acceptSaved(next: AppSettings) {
      session.acceptSaved(next);
      setSettings(next);
    },
    draftChanged: handleSettingsDraftChange,
    acceptValidation: setValidation,
    save: saveSettings,
    testConnection,
    removeKey: removeLinearKey,
    resetPrompt,
  };
}
export type SettingsController = ReturnType<typeof useSettingsController>;
