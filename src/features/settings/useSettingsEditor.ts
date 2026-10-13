import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../bindings";
import * as desktopCommands from "../../desktop/commands";
import {
  SettingsValidationController,
  type SettingsValidationState,
} from "../../settingsValidationController";
import { formSnapshot } from "../../viewPrimitives";
import type { SettingsController } from "./useSettingsController";
export function useSettingsEditor(controller: SettingsController, runtimeAvailable: boolean) {
  const {
    saved: loaded,
    session,
    savePending,
    draftChanged: onDraftChange,
    acceptValidation: onValidationResult,
    save: onSave,
    removeKey: onRemoveKey,
    resetPrompt: onResetPrompt,
  } = controller;
  // The editor only mounts after bootstrap has supplied saved settings.
  const [draft, setDraft] = useState(() => {
    const initial = session.readDraft() ?? loaded;
    if (!initial) throw new Error("Settings editor requires loaded settings");
    return initial;
  });
  const savedSettings = loaded ?? draft;
  const [linearKey, setLinearKeyState] = useState(() => session.readKey());
  const [validationState, setValidationState] = useState<SettingsValidationState>(
    runtimeAvailable
      ? { status: "idle", result: null, stale: false }
      : { status: "unavailable", result: null, stale: false },
  );
  const dirtyRef = useRef(controller.dirty);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [focusInvalidSummary, setFocusInvalidSummary] = useState(false);
  const [promptSeedRevision, setPromptSeedRevision] = useState(0);
  const deferredValidationRef = useRef(false);
  const controllerRef = useRef<SettingsValidationController | null>(null);
  const mountedRef = useRef(false);
  const onValidationResultRef = useRef(onValidationResult);
  onValidationResultRef.current = onValidationResult;

  // Lazily create the controller and remint only when runtime availability
  // changes or the previous one was disposed. Effect teardown must NOT dispose —
  // React Strict Mode runs cleanup→setup on the same fiber, and disposing there
  // permanently breaks Save.
  const ensureController = useCallback(() => {
    const existing = controllerRef.current;
    if (existing && !existing.isDisposed && existing.runtimeAvailable === runtimeAvailable) {
      return existing;
    }
    // Drop the previous instance only when Save does not own it.
    if (existing && !existing.isDisposed && !session.ownsSave(existing)) {
      existing.dispose();
    }
    const created = new SettingsValidationController(
      runtimeAvailable,
      desktopCommands.validateSettings,
      (state) => {
        if (!mountedRef.current) return;
        // Keep pending updates low-priority, but flush terminal states immediately
        // so Save can read the real error instead of a stale/generic banner.
        if (state.status === "pending") {
          startTransition(() => setValidationState(state));
        } else {
          setValidationState(state);
        }
        if (state.result && state.status !== "pending") {
          onValidationResultRef.current(state.result);
        }
      },
    );
    controllerRef.current = created;
    return created;
  }, [session, runtimeAvailable]);

  const scheduleValidation = useCallback(
    (revision: { id: number; settings: AppSettings }) => {
      const controller = ensureController();
      if (session.isSaving() && !session.ownsSave(controller)) {
        deferredValidationRef.current = true;
        return;
      }
      controller.schedule(revision);
    },
    [ensureController, session],
  );

  const updateDirty = useCallback(
    (next: AppSettings, nextKey: string) => {
      const baseline = formSnapshot(savedSettings);
      const dirty = formSnapshot(next) !== baseline || nextKey.trim() !== "";
      if (dirtyRef.current === dirty) return;
      dirtyRef.current = dirty;
      session.setDirty(dirty);
    },
    [session, savedSettings],
  );

  useEffect(() => {
    dirtyRef.current = controller.dirty;
  }, [controller.dirty]);

  const setSettingsDraft = useCallback(
    (next: AppSettings) => {
      const previous = session.readDraft() ?? draft;
      const normalized =
        next.prompt_template === draft.prompt_template
          ? { ...next, prompt_template: previous.prompt_template }
          : next;
      setDraft(normalized);
      session.replaceDraft(normalized);
      onDraftChange(normalized, session.readKey(), previous);
      const revision = { id: session.advanceRevision(), settings: normalized };
      scheduleValidation(revision);
      updateDirty(normalized, session.readKey());
    },
    [draft, session, onDraftChange, scheduleValidation, updateDirty],
  );

  const setPromptDraft = useCallback(
    (prompt: string) => {
      const previous = session.readDraft() ?? draft;
      const next = { ...previous, prompt_template: prompt };
      session.replaceDraft(next);
      // Keep feature draft aligned without urgent shell work so a PromptEditor
      // remount reseeds from the latest prompt, not a stale parent value.
      startTransition(() => setDraft(next));
      onDraftChange(next, session.readKey(), previous);
      scheduleValidation({ id: session.advanceRevision(), settings: next });
      updateDirty(next, session.readKey());
    },
    [draft, session, onDraftChange, scheduleValidation, updateDirty],
  );

  const setLinearKey = useCallback(
    (next: string) => {
      setLinearKeyState(next);
      session.replaceKey(next);
      session.advanceRevision();
      const current = session.readDraft() ?? draft;
      onDraftChange(current, next, current);
      updateDirty(current, next);
    },
    [draft, session, onDraftChange, updateDirty],
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = ensureController();
    const current = session.readDraft();
    if (current) {
      controller.schedule({ id: session.revision(), settings: current });
    }
    return () => {
      mountedRef.current = false;
      // Clear debounce only — never dispose here. Strict Mode's fake teardown
      // would otherwise leave Save pointed at a dead controller on the same fiber.
      controller.clearScheduled();
    };
  }, [session, ensureController]);

  useEffect(() => {
    if (savePending) {
      if (!session.ownsSave(controllerRef.current)) {
        deferredValidationRef.current = true;
      }
      return;
    }
    if (!deferredValidationRef.current) return;
    deferredValidationRef.current = false;
    const current = session.readDraft() ?? savedSettings;
    ensureController().schedule({ id: session.revision(), settings: current });
  }, [session, ensureController, savePending, savedSettings]);

  useEffect(() => {
    const preserved = dirtyRef.current ? (session.readDraft() ?? draft) : savedSettings;
    const next =
      preserved.settings_revision === savedSettings.settings_revision
        ? preserved
        : { ...preserved, settings_revision: savedSettings.settings_revision };
    if (next === session.readDraft()) return;
    session.replaceDraft(next);
    setDraft(next);
  }, [draft, session, savedSettings]);

  useEffect(() => {
    if (!focusInvalidSummary) return;
    if (validationState.status !== "invalid" && validationState.status !== "unavailable") {
      return;
    }
    summaryRef.current?.focus();
    setFocusInvalidSummary(false);
  }, [focusInvalidSummary, validationState.status]);

  const handleSave = useCallback(async () => {
    if (session.isSaving()) return;
    const activeController = ensureController();
    if (!session.beginSave(activeController)) return;
    try {
      const exactSettings = session.readDraft() ?? draft;
      const exactLinearKey = session.readKey();
      const exactRevision = { id: session.revision(), settings: exactSettings };
      const outcome = await activeController.validateNow(exactRevision);
      if (session.revision() !== exactRevision.id) return;
      if (outcome.status === "unavailable") {
        if (outcome.cause === "superseded") return;
        setValidationState({
          status: "unavailable",
          result: null,
          stale: false,
          reason: outcome.reason,
        });
        setFocusInvalidSummary(true);
        return;
      }
      const result = outcome.result;
      if (result.workflow_blocking) {
        setFocusInvalidSummary(true);
        return;
      }
      const saved = await onSave(exactSettings, exactLinearKey, result);
      if (!saved || session.revision() !== exactRevision.id) return;
      session.replaceDraft(saved);
      setDraft(saved);
      session.replaceKey("");
      setLinearKeyState("");
      dirtyRef.current = false;
      session.setDirty(false);
    } finally {
      session.finishSave(activeController);
    }
  }, [draft, session, ensureController, onSave]);

  const handleRemoveKey = useCallback(async () => {
    const linearApiKeySet = await onRemoveKey();
    if (linearApiKeySet === undefined) return;
    setLinearKey("");
    setSettingsDraft({ ...(session.readDraft() ?? draft), linear_api_key_set: linearApiKeySet });
  }, [draft, session, onRemoveKey, setLinearKey, setSettingsDraft]);

  const handleResetPrompt = useCallback(async () => {
    const prompt = await onResetPrompt();
    const previous = session.readDraft() ?? draft;
    const next = { ...previous, prompt_template: prompt };
    session.replaceDraft(next);
    setDraft(next);
    setPromptSeedRevision((revision) => revision + 1);
    onDraftChange(next, session.readKey(), previous);
    scheduleValidation({ id: session.advanceRevision(), settings: next });
    updateDirty(next, session.readKey());
  }, [draft, session, onDraftChange, onResetPrompt, scheduleValidation, updateDirty]);

  return {
    settings: draft,
    setSettings: setSettingsDraft,
    linearKey,
    setLinearKey,
    validation: validationState.result,
    validationState,
    validationSummaryRef: summaryRef,
    promptSeedRevision,
    onPromptChange: setPromptDraft,
    onSave: handleSave,
    onTestConnection: () =>
      controller.testConnection(session.readDraft() ?? draft, session.readKey()),
    onRemoveKey: handleRemoveKey,
    onResetPrompt: handleResetPrompt,
  };
}
