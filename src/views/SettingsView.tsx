import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import * as desktopCommands from "../desktop/commands";
import { getDesktopVersion, openExternalUrl, revealDesktopPath } from "../desktop/shell";
import type { InputHTMLAttributes } from "react";
import type {
  AppSettings,
  LinearViewerProfile,
  RepoConfig,
  RepoWorkflowStatus,
  SkillsInstallStatus,
  SkillsStatus,
  TrackerTestResult,
  ValidationResult,
  WorkflowTransferStatus,
} from "../bindings";
import { SettingsValidationController } from "../settingsValidationController";
import type { SettingsValidationState } from "../settingsValidationController";
import { nullable } from "../format";
import { reconcileSettingsDraft } from "../viewHelpers";
import "./IconSelect.css";
import "./SettingsView.css";

const SETTINGS_FORM_ID = "settings-form";
const GITHUB_URL = "https://github.com/anantjain-xyz/symphony-rust";
const literalInputProps = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
} as const;

const SETTINGS_SECTIONS = [
  { id: "linear", label: "Linear", description: "Connect and choose work" },
  { id: "repositories", label: "Repositories", description: "Route issues to code" },
  { id: "runtime", label: "Agent & runtime", description: "Control how work runs" },
  { id: "workflow", label: "Workflow", description: "Set default instructions" },
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function settingsSectionForScrollPosition({
  viewportTop,
  scrollTop,
  clientHeight,
  scrollHeight,
  sectionTops,
}: {
  viewportTop: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  sectionTops: Partial<Record<SettingsSectionId, number>>;
}): SettingsSectionId {
  const maxScrollTop = scrollHeight - clientHeight;
  if (maxScrollTop > 1 && scrollTop >= maxScrollTop - 1) {
    return SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id;
  }
  const activationLine = viewportTop + 24;
  let current: SettingsSectionId = SETTINGS_SECTIONS[0].id;
  for (const section of SETTINGS_SECTIONS) {
    const top = sectionTops[section.id];
    if (top !== undefined && top <= activationLine) current = section.id;
  }
  return current;
}

function formSnapshot(settings: AppSettings) {
  const { linear_api_key_set: _ignored, ...form } = settings;
  return JSON.stringify(form);
}

type SettingsNumberInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type" | "value"
> & {
  emptyValue?: number;
  minValue: number;
  value: number;
  onValidChange: (value: number) => void;
};

function SettingsNumberInput({
  value,
  emptyValue = 0,
  minValue,
  onValidChange,
  onBlur,
  onFocus,
  ...inputProps
}: SettingsNumberInputProps) {
  const formattedValue = String(value);
  const [draft, setDraft] = useState(formattedValue);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(formattedValue);
  }, [focused, formattedValue]);

  const commitIfValid = (input: HTMLInputElement, { allowEmpty = false } = {}) => {
    if (input.value.trim() === "") {
      if (!allowEmpty) return false;
      onValidChange(emptyValue);
      setDraft(String(emptyValue));
      return true;
    }
    const n = input.valueAsNumber;
    if (!Number.isFinite(n) || n < minValue) return false;
    onValidChange(n);
    return true;
  };

  return (
    <input
      {...literalInputProps}
      {...inputProps}
      type="number"
      required
      value={draft}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        commitIfValid(event.currentTarget);
      }}
      onBlur={(event) => {
        setFocused(false);
        if (!commitIfValid(event.currentTarget, { allowEmpty: true })) {
          setDraft(formattedValue);
        }
        onBlur?.(event);
      }}
    />
  );
}
const BUNDLED_SKILL_NAMES = [
  "symphony-commit",
  "symphony-land",
  "symphony-pr-feedback",
  "symphony-pull",
  "symphony-push",
  "symphony-screenshot",
  "symphony-workpad",
];
const BUNDLED_SKILL_COUNT = BUNDLED_SKILL_NAMES.length;
const BUNDLED_SKILL_EXAMPLES = "symphony-workpad, symphony-commit, symphony-push";

// Mirrors PROMPT_VARIABLES in symphony-core (crates/symphony-core/src/prompt.rs).
const PROMPT_VARIABLES: { name: string; description: string; example: string }[] = [
  { name: "issue.identifier", description: "Issue key", example: "SYM-42" },
  { name: "issue.title", description: "Issue title", example: "Add user login" },
  { name: "issue.description", description: "Full issue body; empty if none", example: "" },
  { name: "issue.state", description: "Current Linear state", example: "Todo" },
  {
    name: "issue.branch",
    description: "Git branch from Linear; may be empty",
    example: "symphony/SYM-42",
  },
  { name: "issue.labels", description: "Labels, comma-separated", example: "bug, ui" },
  {
    name: "issue.blockers",
    description: "Blocking issues, one bullet per line",
    example: "- SYM-41",
  },
  { name: "issue.id", description: "Internal Linear ID", example: "" },
  { name: "repo.name", description: "Name of the repo this issue routed to", example: "widgets" },
  {
    name: "repo.url",
    description: "Git URL of the routed repo",
    example: "git@github.com:org/repo.git",
  },
];

type SettingsFeatureProps = {
  savedSettings: AppSettings;
  draftRef: { current: AppSettings | null };
  revisionRef: { current: number };
  linearKeyRef: { current: string };
  linearViewer: LinearViewerProfile | null;
  linearViewerLoading: boolean;
  linearViewerError: string | null;
  trackerTest: TrackerTestResult | null;
  skillsStatuses: Record<string, SkillsStatus>;
  skillsChecking: Record<string, boolean>;
  skillsInstall: SkillsInstallStatus | null;
  workflowStatuses: Record<string, RepoWorkflowStatus>;
  workflowChecking: Record<string, boolean>;
  workflowTransfer: WorkflowTransferStatus | null;
  settingsDirty: boolean;
  workerRunning: boolean;
  workerConfigError: boolean;
  liveReconfigureSkipped: boolean;
  activeRunCount: number;
  busy: boolean;
  runtimeAvailable: boolean;
  onDirtyChange: (dirty: boolean) => void;
  savePendingRef: { current: boolean };
  saveControllerRef: { current: SettingsValidationController | null };
  savePending: boolean;
  onSavePendingChange: (pending: boolean) => void;
  onValidationResult: (result: ValidationResult) => void;
  onDraftChange: (next: AppSettings, linearKey: string, previous: AppSettings) => void;
  onSave: (
    settings: AppSettings,
    linearKey: string,
    result: ValidationResult,
  ) => Promise<AppSettings | undefined>;
  onTestConnection: (settings: AppSettings, linearKey: string) => void;
  onRemoveKey: () => Promise<boolean | undefined>;
  onResetPrompt: () => Promise<string>;
  onRefreshSkills: (repoUrl: string, sessionEnv: AppSettings["session_env"]) => void;
  onInstallSkills: (settings: AppSettings, repoUrl: string) => void;
  onRefreshWorkflow: (repoUrl: string, sessionEnv: AppSettings["session_env"]) => void;
  onTransferWorkflow: (repoUrl: string) => void;
};

function validationFieldId(result: ValidationResult | null) {
  const message = result?.workflow_error?.toLowerCase() ?? "";
  if (message.includes("active state")) return "settings-active-states";
  if (message.includes("prompt") || message.includes("placeholder")) {
    return "settings-prompt-template";
  }
  if (message.includes("repo")) return "settings-repositories";
  return null;
}

function settingsSectionForField(fieldId: string | null): SettingsSectionId {
  if (fieldId === "settings-repositories") return "repositories";
  if (fieldId === "settings-prompt-template") return "workflow";
  return "linear";
}

function SettingsFeature({
  savedSettings,
  draftRef,
  revisionRef,
  linearKeyRef,
  onDirtyChange,
  savePendingRef,
  saveControllerRef,
  savePending,
  onSavePendingChange,
  onValidationResult,
  onDraftChange,
  onSave,
  onTestConnection,
  onRemoveKey,
  onResetPrompt,
  onRefreshSkills,
  onInstallSkills,
  onRefreshWorkflow,
  ...viewProps
}: SettingsFeatureProps) {
  const [draft, setDraft] = useState(() => draftRef.current ?? savedSettings);
  const [linearKey, setLinearKeyState] = useState(() => linearKeyRef.current);
  const [validationState, setValidationState] = useState<SettingsValidationState>(
    viewProps.runtimeAvailable
      ? { status: "idle", result: null, stale: false }
      : { status: "unavailable", result: null, stale: false },
  );
  const dirtyRef = useRef(viewProps.settingsDirty);
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
    if (
      existing &&
      !existing.isDisposed &&
      existing.runtimeAvailable === viewProps.runtimeAvailable
    ) {
      return existing;
    }
    // Drop the previous instance only when Save does not own it.
    if (existing && !existing.isDisposed && saveControllerRef.current !== existing) {
      existing.dispose();
    }
    const created = new SettingsValidationController(
      viewProps.runtimeAvailable,
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
  }, [saveControllerRef, viewProps.runtimeAvailable]);

  const scheduleValidation = useCallback(
    (revision: { id: number; settings: AppSettings }) => {
      const controller = ensureController();
      if (savePendingRef.current && saveControllerRef.current !== controller) {
        deferredValidationRef.current = true;
        return;
      }
      controller.schedule(revision);
    },
    [ensureController, saveControllerRef, savePendingRef],
  );

  const updateDirty = useCallback(
    (next: AppSettings, nextKey: string) => {
      const baseline = formSnapshot(savedSettings);
      const dirty = formSnapshot(next) !== baseline || nextKey.trim() !== "";
      if (dirtyRef.current === dirty) return;
      dirtyRef.current = dirty;
      onDirtyChange(dirty);
    },
    [onDirtyChange, savedSettings],
  );

  useEffect(() => {
    dirtyRef.current = viewProps.settingsDirty;
  }, [viewProps.settingsDirty]);

  const setSettingsDraft = useCallback(
    (next: AppSettings) => {
      const previous = draftRef.current ?? draft;
      const normalized =
        next.prompt_template === draft.prompt_template
          ? { ...next, prompt_template: previous.prompt_template }
          : next;
      setDraft(normalized);
      draftRef.current = normalized;
      onDraftChange(normalized, linearKeyRef.current, previous);
      const revision = { id: ++revisionRef.current, settings: normalized };
      scheduleValidation(revision);
      updateDirty(normalized, linearKeyRef.current);
    },
    [draft, draftRef, linearKeyRef, onDraftChange, revisionRef, scheduleValidation, updateDirty],
  );

  const setPromptDraft = useCallback(
    (prompt: string) => {
      const previous = draftRef.current ?? draft;
      const next = { ...previous, prompt_template: prompt };
      draftRef.current = next;
      // Keep feature draft aligned without urgent shell work so a PromptEditor
      // remount reseeds from the latest prompt, not a stale parent value.
      startTransition(() => setDraft(next));
      onDraftChange(next, linearKeyRef.current, previous);
      scheduleValidation({ id: ++revisionRef.current, settings: next });
      updateDirty(next, linearKeyRef.current);
    },
    [draft, draftRef, linearKeyRef, onDraftChange, revisionRef, scheduleValidation, updateDirty],
  );

  const setLinearKey = useCallback(
    (next: string) => {
      setLinearKeyState(next);
      linearKeyRef.current = next;
      revisionRef.current += 1;
      const current = draftRef.current ?? draft;
      onDraftChange(current, next, current);
      updateDirty(current, next);
    },
    [draft, draftRef, linearKeyRef, onDraftChange, revisionRef, updateDirty],
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = ensureController();
    const current = draftRef.current;
    if (current) {
      controller.schedule({ id: revisionRef.current, settings: current });
    }
    return () => {
      mountedRef.current = false;
      // Clear debounce only — never dispose here. Strict Mode's fake teardown
      // would otherwise leave Save pointed at a dead controller on the same fiber.
      controller.clearScheduled();
    };
  }, [draftRef, ensureController, revisionRef]);

  useEffect(() => {
    if (savePending) {
      if (saveControllerRef.current !== controllerRef.current) {
        deferredValidationRef.current = true;
      }
      return;
    }
    if (!deferredValidationRef.current) return;
    deferredValidationRef.current = false;
    const current = draftRef.current ?? savedSettings;
    ensureController().schedule({ id: revisionRef.current, settings: current });
  }, [draftRef, ensureController, revisionRef, saveControllerRef, savePending, savedSettings]);

  useEffect(() => {
    const next = reconcileSettingsDraft(savedSettings, draftRef.current ?? draft, dirtyRef.current);
    if (next === draftRef.current) return;
    draftRef.current = next;
    setDraft(next);
  }, [draft, draftRef, savedSettings]);

  useEffect(() => {
    if (!focusInvalidSummary) return;
    if (validationState.status !== "invalid" && validationState.status !== "unavailable") {
      return;
    }
    summaryRef.current?.focus();
    setFocusInvalidSummary(false);
  }, [focusInvalidSummary, validationState.status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revisionRef.current is mutable validation state, not a render dependency.
  const handleSave = useCallback(async () => {
    if (savePendingRef.current) return;
    const activeController = ensureController();
    savePendingRef.current = true;
    saveControllerRef.current = activeController;
    onSavePendingChange(true);
    try {
      const exactSettings = draftRef.current ?? draft;
      const exactLinearKey = linearKeyRef.current;
      const exactRevision = { id: revisionRef.current, settings: exactSettings };
      const outcome = await activeController.validateNow(exactRevision);
      if (revisionRef.current !== exactRevision.id) return;
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
      if (!saved || revisionRef.current !== exactRevision.id) return;
      draftRef.current = saved;
      setDraft(saved);
      linearKeyRef.current = "";
      setLinearKeyState("");
      dirtyRef.current = false;
      onDirtyChange(false);
    } finally {
      savePendingRef.current = false;
      if (saveControllerRef.current === activeController) {
        saveControllerRef.current = null;
      }
      onSavePendingChange(false);
    }
  }, [
    draft,
    draftRef,
    ensureController,
    linearKeyRef,
    onDirtyChange,
    onSave,
    onSavePendingChange,
    saveControllerRef,
    savePendingRef,
  ]);

  const handleRemoveKey = useCallback(async () => {
    const linearApiKeySet = await onRemoveKey();
    if (linearApiKeySet === undefined) return;
    setLinearKey("");
    setSettingsDraft({ ...(draftRef.current ?? draft), linear_api_key_set: linearApiKeySet });
  }, [draft, draftRef, onRemoveKey, setLinearKey, setSettingsDraft]);

  const handleResetPrompt = useCallback(async () => {
    const prompt = await onResetPrompt();
    const previous = draftRef.current ?? draft;
    const next = { ...previous, prompt_template: prompt };
    draftRef.current = next;
    setDraft(next);
    setPromptSeedRevision((revision) => revision + 1);
    onDraftChange(next, linearKeyRef.current, previous);
    scheduleValidation({ id: ++revisionRef.current, settings: next });
    updateDirty(next, linearKeyRef.current);
  }, [
    draft,
    draftRef,
    linearKeyRef,
    onDraftChange,
    onResetPrompt,
    revisionRef,
    scheduleValidation,
    updateDirty,
  ]);

  return (
    <SettingsView
      {...viewProps}
      settings={draft}
      setSettings={setSettingsDraft}
      linearKey={linearKey}
      setLinearKey={setLinearKey}
      validation={validationState.result}
      validationState={validationState}
      validationSummaryRef={summaryRef}
      promptSeedRevision={promptSeedRevision}
      onPromptChange={setPromptDraft}
      onSave={handleSave}
      onTestConnection={() => onTestConnection(draftRef.current ?? draft, linearKeyRef.current)}
      onRemoveKey={handleRemoveKey}
      onResetPrompt={handleResetPrompt}
      onRefreshSkills={(repoUrl) => {
        const current = draftRef.current ?? draft;
        onRefreshSkills(repoUrl, current.session_env);
      }}
      onInstallSkills={(repoUrl) => onInstallSkills(draftRef.current ?? draft, repoUrl)}
      onRefreshWorkflow={(repoUrl) => {
        const current = draftRef.current ?? draft;
        onRefreshWorkflow(repoUrl, current.session_env);
      }}
    />
  );
}

function SettingsView({
  settings,
  setSettings,
  linearKey,
  setLinearKey,
  linearViewer,
  linearViewerLoading,
  linearViewerError,
  validation,
  validationState,
  validationSummaryRef,
  promptSeedRevision,
  onPromptChange,
  trackerTest,
  skillsStatuses,
  skillsChecking,
  skillsInstall,
  workflowStatuses,
  workflowChecking,
  workflowTransfer,
  settingsDirty,
  workerRunning,
  workerConfigError,
  liveReconfigureSkipped,
  activeRunCount,
  busy,
  runtimeAvailable,
  onSave,
  onTestConnection,
  onRemoveKey,
  onResetPrompt,
  onRefreshSkills,
  onInstallSkills,
  onRefreshWorkflow,
  onTransferWorkflow,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  linearKey: string;
  setLinearKey: (value: string) => void;
  linearViewer: LinearViewerProfile | null;
  linearViewerLoading: boolean;
  linearViewerError: string | null;
  validation: ValidationResult | null;
  validationState: SettingsValidationState;
  validationSummaryRef: { current: HTMLDivElement | null };
  promptSeedRevision: number;
  onPromptChange: (prompt: string) => void;
  trackerTest: TrackerTestResult | null;
  skillsStatuses: Record<string, SkillsStatus>;
  skillsChecking: Record<string, boolean>;
  skillsInstall: SkillsInstallStatus | null;
  workflowStatuses: Record<string, RepoWorkflowStatus>;
  workflowChecking: Record<string, boolean>;
  workflowTransfer: WorkflowTransferStatus | null;
  settingsDirty: boolean;
  workerRunning: boolean;
  workerConfigError: boolean;
  liveReconfigureSkipped: boolean;
  activeRunCount: number;
  busy: boolean;
  runtimeAvailable: boolean;
  onSave: () => void;
  onTestConnection: () => void;
  onRemoveKey: () => void;
  onResetPrompt: () => void;
  onRefreshSkills: (repoUrl: string) => void;
  onInstallSkills: (repoUrl: string) => void;
  onRefreshWorkflow: (repoUrl: string) => void;
  onTransferWorkflow: (repoUrl: string) => void;
}) {
  const activeStatesEmpty = settings.active_states.every((state) => state.trim() === "");
  const [expandedRepoIndex, setExpandedRepoIndex] = useState<number | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("linear");
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!runtimeAvailable) return;
    let cancelled = false;
    void getDesktopVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runtimeAvailable]);

  useEffect(() => {
    setExpandedRepoIndex((index) => {
      if (settings.repos.length === 0) return null;
      if (index === null) return null;
      return Math.min(index, settings.repos.length - 1);
    });
  }, [settings.repos.length]);

  useEffect(() => {
    const viewport = document.querySelector<HTMLElement>(".content");
    if (!viewport) return;
    let frame: number | null = null;
    const updateActiveSection = () => {
      frame = null;
      const sectionTops: Partial<Record<SettingsSectionId, number>> = {};
      for (const section of SETTINGS_SECTIONS) {
        const element = document.getElementById(`settings-${section.id}`);
        if (element) sectionTops[section.id] = element.getBoundingClientRect().top;
      }
      setActiveSection(
        settingsSectionForScrollPosition({
          viewportTop: viewport.getBoundingClientRect().top,
          scrollTop: viewport.scrollTop,
          clientHeight: viewport.clientHeight,
          scrollHeight: viewport.scrollHeight,
          sectionTops,
        }),
      );
    };
    const onScroll = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateActiveSection);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    updateActiveSection();
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  const updateRepo = (index: number, patch: Partial<RepoConfig>) => {
    setExpandedRepoIndex(index);
    setSettings({
      ...settings,
      repos: settings.repos.map((repo, i) => (i === index ? { ...repo, ...patch } : repo)),
    });
  };
  const addRepo = () => {
    setExpandedRepoIndex(settings.repos.length);
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
          // The first repo starts as the fallback, but users can clear it.
          is_default: settings.repos.length === 0,
          skills_marked_installed: false,
        },
      ],
    });
  };
  const removeRepo = (index: number) => {
    setExpandedRepoIndex((current) => {
      const nextLength = settings.repos.length - 1;
      if (nextLength <= 0) return null;
      if (current === null) return null;
      if (current === index) return Math.min(index, nextLength - 1);
      if (current > index) return current - 1;
      return Math.min(current, nextLength - 1);
    });
    setSettings({ ...settings, repos: settings.repos.filter((_, i) => i !== index) });
  };
  const setDefaultRepo = (index: number, enabled: boolean) => {
    setExpandedRepoIndex(index);
    setSettings({
      ...settings,
      repos: settings.repos.map((repo, i) => ({
        ...repo,
        is_default: enabled && i === index,
      })),
    });
  };
  return (
    <form
      className="settings-form"
      id={SETTINGS_FORM_ID}
      autoComplete="off"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <header className="page-header">
        <div>
          <h2>Settings</h2>
          <p>Configure how Symphony discovers, routes, and runs work.</p>
        </div>
      </header>

      {!runtimeAvailable ? (
        <div className="banner info">
          Settings are shown in preview mode. Open Symphony as a Tauri desktop app to edit,
          validate, and save configuration.
        </div>
      ) : null}
      {runtimeAvailable && workerRunning ? (
        <div className="banner info">
          <strong>
            {workerConfigError || liveReconfigureSkipped ? "Worker configuration" : "Live worker"}
          </strong>
          <span>
            {workerConfigError
              ? "Settings save to disk, but the live worker reported a configuration error and may keep its previous runtime config until the error is fixed."
              : liveReconfigureSkipped
                ? "Settings save to disk, but this configuration is incomplete, so the live worker keeps its previous runtime config until setup is runnable."
                : `Saved settings apply to future dispatches without restarting the worker. ${
                    activeRunCount > 0
                      ? `${activeRunCount} active ${
                          activeRunCount === 1 ? "run keeps" : "runs keep"
                        } the config ${activeRunCount === 1 ? "it" : "they"} started with.`
                      : "No active runs are using an older config."
                  }`}
          </span>
        </div>
      ) : null}

      <div
        ref={validationSummaryRef}
        className={`banner ${validationState.status === "invalid" ? "error" : "info"}`}
        id="settings-validation-summary"
        role={validationState.status === "invalid" ? "alert" : "status"}
        aria-live="polite"
        aria-busy={validationState.status === "pending" ? "true" : undefined}
        tabIndex={-1}
        hidden={validationState.status === "valid" || validationState.status === "idle"}
      >
        {validationState.status === "pending" ? (
          <>
            <strong>Checking latest changes…</strong>
            {validationState.result ? <span>Previous result is stale.</span> : null}
          </>
        ) : validationState.status === "invalid" ? (
          <>
            <strong>Settings need attention</strong>
            <span>{validationState.result.workflow_error}</span>
            {validationFieldId(validationState.result) ? (
              <a
                href={`#${validationFieldId(validationState.result)}`}
                onClick={() => {
                  const fieldId = validationFieldId(validationState.result);
                  setActiveSection(settingsSectionForField(fieldId));
                  document.getElementById(fieldId ?? "")?.focus();
                }}
              >
                Go to the first affected field
              </a>
            ) : null}
          </>
        ) : validationState.status === "unavailable" ? (
          <>
            <strong>Validation unavailable</strong>
            <span>
              {validationState.reason ??
                (runtimeAvailable
                  ? "Couldn't validate settings. Try saving again."
                  : "Desktop validation is not available in browser preview.")}
            </span>
          </>
        ) : null}
      </div>

      <div className="settings-layout">
        <nav className="settings-sidebar" aria-label="Settings sections">
          <span className="settings-sidebar-label">Setup</span>
          {SETTINGS_SECTIONS.map((section, index) => (
            <a
              key={section.id}
              className={activeSection === section.id ? "active" : undefined}
              href={`#settings-${section.id}`}
              aria-current={activeSection === section.id ? "location" : undefined}
              onClick={() => {
                setActiveSection(section.id);
                const target = document.getElementById(`settings-${section.id}`);
                window.requestAnimationFrame(() => target?.focus({ preventScroll: true }));
              }}
            >
              <span className="settings-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="settings-step-copy">
                <strong>{section.label}</strong>
                <small>{section.description}</small>
              </span>
            </a>
          ))}
        </nav>

        <div className="settings-panes">
          <div className="settings-stage settings-stage-linear" id="settings-linear" tabIndex={-1}>
            <section className="settings-section">
              <h3>Linear</h3>
              <label>
                API key
                <input
                  {...literalInputProps}
                  value={linearKey}
                  disabled={!runtimeAvailable}
                  type="password"
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
                  {...literalInputProps}
                  value={settings.tracker_workspace ?? ""}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({ ...settings, tracker_workspace: nullable(e.currentTarget.value) })
                  }
                  placeholder="acme"
                />
                <small className="hint">
                  Your workspace slug — the first path segment in linear.app URLs. Enables issue
                  links.
                </small>
              </label>
              <label>
                Project ID
                <input
                  {...literalInputProps}
                  value={settings.tracker_project_id ?? ""}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      tracker_project_id: nullable(e.currentTarget.value),
                    })
                  }
                />
                <small className="hint">
                  Optional. Watch a single project by pasting its Linear URL or project ID.
                </small>
              </label>
              <label>
                Team prefix
                <input
                  {...literalInputProps}
                  value={settings.tracker_prefix ?? ""}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({ ...settings, tracker_prefix: nullable(e.currentTarget.value) })
                  }
                  placeholder="ENG"
                />
                <small className="hint">
                  Optional. Watch only issues whose identifier starts with this team key.
                </small>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.tracker_assigned_to_me}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      tracker_assigned_to_me: e.currentTarget.checked,
                    })
                  }
                />
                <span>
                  Only pick issues assigned to me{" "}
                  {settings.tracker_assigned_to_me ? (
                    <span className="inline-meta">
                      {linearViewerLoading
                        ? "Checking Linear..."
                        : linearViewer
                          ? linearViewer.username
                          : ""}
                    </span>
                  ) : null}
                </span>
                <small className="hint">
                  When enabled, Symphony dispatches matching active issues only from the Linear user
                  tied to the configured API key.
                </small>
                {settings.tracker_assigned_to_me && linearViewerError ? (
                  <small className="test-result err">{linearViewerError}</small>
                ) : null}
              </label>
              <label htmlFor="settings-active-states">
                Active states
                <ListInput
                  id="settings-active-states"
                  value={settings.active_states}
                  disabled={!runtimeAvailable}
                  separator="comma"
                  placeholder="Todo, In Progress, Rework, Merging"
                  onChange={(next) => setSettings({ ...settings, active_states: next })}
                  aria-invalid={
                    validationState.status === "invalid" &&
                    validationFieldId(validationState.result) === "settings-active-states"
                  }
                  aria-describedby={
                    validationState.status === "invalid" &&
                    validationFieldId(validationState.result) === "settings-active-states"
                      ? "settings-validation-summary"
                      : undefined
                  }
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
              <label htmlFor="settings-terminal-states">
                Terminal states
                <ListInput
                  id="settings-terminal-states"
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
          </div>

          <div
            className="settings-stage settings-stage-repositories"
            id="settings-repositories"
            tabIndex={-1}
          >
            <section className="settings-section">
              <h3>Repositories</h3>
              <small className="hint">
                Each issue routes to one repo: a <code>repo:&lt;name&gt;</code> or matching bare
                label in Linear wins, then the repo claiming the issue's project, then its team,
                then the default. Clear the default to require an explicit route.
              </small>
              {settings.repos.map((repo, index) => {
                const repoTitle = repo.name.trim() || `Repository ${index + 1}`;
                const repoSummary = repo.url.trim() || "No URL configured";
                const expanded = expandedRepoIndex === index;
                const bodyId = `repo-card-body-${index}`;
                const toggleLabel = `${expanded ? "Collapse" : "Edit"} ${repoTitle} repository`;
                const workflowStatus = workflowStatuses[repo.url.trim()] ?? null;
                return (
                  <fieldset
                    className={expanded ? "repo-card expanded" : "repo-card collapsed"}
                    key={
                      // biome-ignore lint/suspicious/noArrayIndexKey: editable unsaved repositories do not have stable identifiers yet.
                      index
                    }
                  >
                    <div className="repo-card-head">
                      <button
                        type="button"
                        className="repo-card-toggle"
                        aria-expanded={expanded}
                        aria-controls={expanded ? bodyId : undefined}
                        aria-label={toggleLabel}
                        title={toggleLabel}
                        onClick={() =>
                          setExpandedRepoIndex((current) => (current === index ? null : index))
                        }
                      >
                        <svg
                          className="chevron"
                          viewBox="0 0 16 16"
                          width="12"
                          height="12"
                          aria-hidden="true"
                        >
                          <path
                            d="M6 4l4 4-4 4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span className="repo-card-title">
                          <strong>{repoTitle}</strong>
                          <small>{repoSummary}</small>
                        </span>
                      </button>
                      <div className="repo-card-actions">
                        <label className="repo-default">
                          <input
                            type="checkbox"
                            checked={repo.is_default}
                            disabled={!runtimeAvailable}
                            onChange={(event) => setDefaultRepo(index, event.currentTarget.checked)}
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
                    {expanded ? (
                      <div className="repo-card-body" id={bodyId}>
                        <label>
                          Name
                          <input
                            {...literalInputProps}
                            value={repo.name}
                            disabled={!runtimeAvailable}
                            onChange={(e) => updateRepo(index, { name: e.currentTarget.value })}
                            placeholder="widgets"
                          />
                          <small className="hint">
                            Label an issue <code>repo:{repo.name.trim() || "<name>"}</code> in
                            Linear to send it here.
                          </small>
                        </label>
                        <label>
                          Repo URL
                          <input
                            {...literalInputProps}
                            value={repo.url}
                            disabled={!runtimeAvailable}
                            onChange={(e) => {
                              const url = e.currentTarget.value;
                              updateRepo(index, {
                                url,
                                skills_marked_installed:
                                  url.trim() === repo.url.trim()
                                    ? repo.skills_marked_installed
                                    : false,
                              });
                            }}
                            placeholder="git@github.com:org/repo.git"
                          />
                          <small className="hint">
                            SSH or HTTPS Git URL. Each run clones it into a fresh workspace.
                          </small>
                        </label>
                        <label>
                          Install command
                          <input
                            {...literalInputProps}
                            value={repo.install_cmd ?? ""}
                            disabled={!runtimeAvailable}
                            onChange={(e) =>
                              updateRepo(index, { install_cmd: nullable(e.currentTarget.value) })
                            }
                            placeholder="npm ci"
                          />
                          <small className="hint">
                            Runs in the workspace after cloning. Leave blank for <code>npm ci</code>
                            .
                          </small>
                        </label>
                        <label htmlFor={`repo-${index}-linear-teams`}>
                          Linear teams
                          <ListInput
                            id={`repo-${index}-linear-teams`}
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
                        <label htmlFor={`repo-${index}-linear-projects`}>
                          Linear projects
                          <ListInput
                            id={`repo-${index}-linear-projects`}
                            value={repo.project_ids}
                            disabled={!runtimeAvailable}
                            separator="comma"
                            placeholder="Project URLs or IDs"
                            onChange={(next) => updateRepo(index, { project_ids: next })}
                          />
                          <small className="hint">
                            Optional. Paste Linear project URLs or IDs; beats the team rule.
                          </small>
                        </label>
                        <WorkflowBlock
                          status={workflowStatus}
                          checking={workflowChecking[repo.url.trim()] ?? false}
                          transfer={
                            workflowTransfer?.repo_url === repo.url.trim() ? workflowTransfer : null
                          }
                          transferRunning={workflowTransfer?.state === "running"}
                          settingsDirty={settingsDirty}
                          busy={busy}
                          runtimeAvailable={runtimeAvailable}
                          repoConfigured={repo.url.trim() !== ""}
                          onRefresh={() => onRefreshWorkflow(repo.url)}
                          onTransfer={() => onTransferWorkflow(repo.url)}
                        />
                        <SkillsBlock
                          status={skillsStatuses[repo.url.trim()] ?? null}
                          checking={skillsChecking[repo.url.trim()] ?? false}
                          manuallyInstalled={repo.skills_marked_installed}
                          install={
                            skillsInstall?.repo_url === repo.url.trim() ? skillsInstall : null
                          }
                          installRunning={skillsInstall?.state === "running"}
                          busy={busy}
                          runtimeAvailable={runtimeAvailable}
                          repoConfigured={repo.url.trim() !== ""}
                          onRefresh={() => onRefreshSkills(repo.url)}
                          onInstall={() => onInstallSkills(repo.url)}
                          onMarkInstalled={() =>
                            updateRepo(index, { skills_marked_installed: true })
                          }
                          onUseAutomaticCheck={() => {
                            updateRepo(index, { skills_marked_installed: false });
                            onRefreshSkills(repo.url);
                          }}
                        />
                      </div>
                    ) : null}
                  </fieldset>
                );
              })}
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
                  {...literalInputProps}
                  value={settings.workspace_root ?? ""}
                  disabled={!runtimeAvailable}
                  onChange={(e) =>
                    setSettings({ ...settings, workspace_root: nullable(e.currentTarget.value) })
                  }
                  placeholder="App data directory"
                />
                <small className="hint">
                  Where per-run workspaces are created (one folder per repo, then per issue). Leave
                  blank to use the app data directory.
                </small>
              </label>
              <small className="hint">
                Agent skills are procedural guides (symphony-workpad, symphony-commit,
                symphony-push, …) that Symphony agents follow. Each run gets bundled fallback copies
                locally when a repo does not ship them. Each card above shows whether its repo has
                checked-in skills; installing starts an agent session that opens a PR adding them
                under <code>.agents/skills/</code>, with validation commands adapted to that repo's
                toolchain.
              </small>
            </section>
          </div>

          <div
            className="settings-stage settings-stage-runtime"
            id="settings-runtime"
            tabIndex={-1}
          >
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
                {validation ? (
                  <AgentCliStatus backend={settings.agent_backend} validation={validation} />
                ) : null}
              </div>
              <label>
                Launch command
                <input
                  {...literalInputProps}
                  className="mono-input"
                  value={
                    settings.agent_backend === "codex"
                      ? (settings.codex_command ?? "")
                      : settings.agent_backend === "claude"
                        ? (settings.claude_command ?? "")
                        : settings.agent_backend === "cursor"
                          ? (settings.cursor_command ?? "")
                          : (settings.opencode_command ?? "")
                  }
                  disabled={!runtimeAvailable}
                  onChange={(e) => {
                    const value = nullable(e.currentTarget.value);
                    if (settings.agent_backend === "codex") {
                      setSettings({ ...settings, codex_command: value });
                    } else if (settings.agent_backend === "claude") {
                      setSettings({ ...settings, claude_command: value });
                    } else if (settings.agent_backend === "cursor") {
                      setSettings({ ...settings, cursor_command: value });
                    } else {
                      setSettings({ ...settings, opencode_command: value });
                    }
                  }}
                  placeholder={
                    settings.agent_backend === "cursor" ? "agent" : settings.agent_backend
                  }
                />
                <small className="hint">
                  Optional. How the agent is launched — e.g. a wrapper like{" "}
                  <code className="command-example">{`mycode --agent ${settings.agent_backend}`}</code>
                  . Leave blank to run <code>{settings.agent_backend}</code> directly.
                </small>
              </label>
              <label htmlFor="settings-turn-timeout">
                Turn timeout (seconds)
                <SettingsNumberInput
                  id="settings-turn-timeout"
                  min={0}
                  minValue={0}
                  step="any"
                  value={settings.turn_timeout_ms / 1000}
                  disabled={!runtimeAvailable}
                  onValidChange={(n) =>
                    setSettings({ ...settings, turn_timeout_ms: Math.round(n * 1000) })
                  }
                />
                <small className="hint">Max time for one agent turn. 3600 = 1 hour.</small>
              </label>
              <label htmlFor="settings-session-environment">
                Session environment
                <EnvInput
                  id="settings-session-environment"
                  value={settings.session_env}
                  disabled={!runtimeAvailable}
                  onChange={(next) => setSettings({ ...settings, session_env: next })}
                />
                <small className="hint">
                  Optional. One <code>KEY=value</code> per line, injected into the agent process
                  (e.g. <code>CURSOR_API_KEY</code> for Cursor). Values are saved in settings.
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
              ) : settings.agent_backend === "claude" ? (
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
                  <label htmlFor="settings-claude-allowed-tools">
                    Allowed tools
                    <ListInput
                      id="settings-claude-allowed-tools"
                      value={settings.claude_allowed_tools}
                      disabled={!runtimeAvailable}
                      separator="newline"
                      rows={8}
                      placeholder={"Bash(gh *)\nBash(git status*)"}
                      onChange={(next) => setSettings({ ...settings, claude_allowed_tools: next })}
                    />
                    <small className="hint">
                      One rule per line. The target repo's <code>.claude/settings.json</code> can
                      add repo-specific extras on top.
                    </small>
                  </label>
                  <label htmlFor="settings-claude-disallowed-tools">
                    Disallowed tools
                    <ListInput
                      id="settings-claude-disallowed-tools"
                      value={settings.claude_disallowed_tools}
                      disabled={!runtimeAvailable}
                      separator="newline"
                      rows={3}
                      onChange={(next) =>
                        setSettings({ ...settings, claude_disallowed_tools: next })
                      }
                    />
                    <small className="hint">
                      One rule per line. Takes precedence over allowed tools.
                    </small>
                  </label>
                  <label htmlFor="settings-claude-additional-directories">
                    Additional directories
                    <ListInput
                      id="settings-claude-additional-directories"
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
              ) : settings.agent_backend === "cursor" ? (
                <>
                  <label>
                    Mode
                    <select
                      value={settings.cursor_mode}
                      disabled={!runtimeAvailable}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          cursor_mode: e.currentTarget.value as AppSettings["cursor_mode"],
                        })
                      }
                    >
                      <option value="agent">Agent</option>
                      <option value="plan">Plan (read-only design)</option>
                      <option value="ask">Ask (read-only exploration)</option>
                    </select>
                    <small className="hint">
                      Agent mode can edit files. Plan and Ask are read-only — use Agent for issue
                      runs.
                    </small>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.cursor_force}
                      disabled={!runtimeAvailable}
                      onChange={(e) =>
                        setSettings({ ...settings, cursor_force: e.currentTarget.checked })
                      }
                    />
                    Force auto-approve
                    <small className="hint">
                      Maps to <code>--force</code>. Required for unattended runs.
                    </small>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.cursor_trust}
                      disabled={!runtimeAvailable}
                      onChange={(e) =>
                        setSettings({ ...settings, cursor_trust: e.currentTarget.checked })
                      }
                    />
                    Trust workspace
                    <small className="hint">
                      Maps to <code>--trust</code>. Skips workspace trust prompts in headless mode.
                    </small>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.cursor_approve_mcps}
                      disabled={!runtimeAvailable}
                      onChange={(e) =>
                        setSettings({ ...settings, cursor_approve_mcps: e.currentTarget.checked })
                      }
                    />
                    Approve MCPs
                    <small className="hint">
                      Maps to <code>--approve-mcps</code>. Auto-approves MCP servers for this run.
                    </small>
                  </label>
                  <label>
                    Sandbox
                    <select
                      value={settings.cursor_sandbox}
                      disabled={!runtimeAvailable}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          cursor_sandbox: e.currentTarget.value as AppSettings["cursor_sandbox"],
                        })
                      }
                    >
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </label>
                  <label>
                    Model
                    <input
                      {...literalInputProps}
                      value={settings.cursor_model ?? ""}
                      disabled={!runtimeAvailable}
                      placeholder="Optional, e.g. composer-2.5"
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          cursor_model: nullable(e.currentTarget.value),
                        })
                      }
                    />
                    <small className="hint">Leave blank for the CLI default.</small>
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Model
                    <input
                      {...literalInputProps}
                      value={settings.opencode_model ?? ""}
                      disabled={!runtimeAvailable}
                      placeholder="Optional, e.g. anthropic/claude-sonnet-4-5"
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          opencode_model: nullable(e.currentTarget.value),
                        })
                      }
                    />
                    <small className="hint">
                      <code>provider/model</code> passed to <code>--model</code>. Leave blank for
                      the CLI default.
                    </small>
                  </label>
                  <label>
                    Agent
                    <input
                      {...literalInputProps}
                      value={settings.opencode_agent ?? ""}
                      disabled={!runtimeAvailable}
                      placeholder="Optional, e.g. build"
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          opencode_agent: nullable(e.currentTarget.value),
                        })
                      }
                    />
                    <small className="hint">
                      Primary agent passed to <code>--agent</code>. Leave blank for the default.
                    </small>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.opencode_skip_permissions}
                      disabled={!runtimeAvailable}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          opencode_skip_permissions: e.currentTarget.checked,
                        })
                      }
                    />
                    Skip permissions
                    <small className="hint">
                      Maps to <code>--dangerously-skip-permissions</code>. Required for unattended
                      runs — without it opencode auto-rejects every tool call.
                    </small>
                  </label>
                </>
              )}
            </section>

            <section className="settings-section">
              <h3>Worker</h3>
              <label htmlFor="settings-polling-interval">
                Polling interval (seconds)
                <SettingsNumberInput
                  id="settings-polling-interval"
                  min={0}
                  minValue={0}
                  step="any"
                  value={settings.polling_interval_ms / 1000}
                  disabled={!runtimeAvailable}
                  onValidChange={(n) =>
                    setSettings({ ...settings, polling_interval_ms: Math.round(n * 1000) })
                  }
                />
                <small className="hint">
                  How often Linear is polled for issues. Applies after Save; the live worker wakes
                  and uses the new interval on its next loop.
                </small>
              </label>
              <label htmlFor="settings-max-concurrent-agents">
                Max concurrent agents
                <SettingsNumberInput
                  id="settings-max-concurrent-agents"
                  min={0}
                  minValue={0}
                  value={settings.max_concurrent_agents}
                  disabled={!runtimeAvailable}
                  onValidChange={(n) =>
                    setSettings({ ...settings, max_concurrent_agents: Math.trunc(n) })
                  }
                />
                <small className="hint">
                  Issues worked on in parallel. Applies to future dispatch decisions;
                  already-running agents continue.
                </small>
              </label>
              <label htmlFor="settings-max-retry-backoff">
                Max retry backoff (seconds)
                <SettingsNumberInput
                  id="settings-max-retry-backoff"
                  min={0}
                  minValue={0}
                  step="any"
                  value={settings.max_retry_backoff_ms / 1000}
                  disabled={!runtimeAvailable}
                  onValidChange={(n) =>
                    setSettings({ ...settings, max_retry_backoff_ms: Math.round(n * 1000) })
                  }
                />
                <small className="hint">
                  Cap on the delay between retries of a failed run. 300 = 5 min.
                </small>
              </label>
              <label htmlFor="settings-hook-timeout">
                Hook timeout (seconds)
                <SettingsNumberInput
                  id="settings-hook-timeout"
                  min={0}
                  minValue={0}
                  step="any"
                  value={settings.hook_timeout_ms / 1000}
                  disabled={!runtimeAvailable}
                  onValidChange={(n) =>
                    setSettings({ ...settings, hook_timeout_ms: Math.round(n * 1000) })
                  }
                />
                <small className="hint">
                  Max time for each hook script. Applies to hooks that start after Save; a hook
                  already running keeps its current timeout.
                </small>
              </label>
              <details className="hooks-details">
                <summary>Hooks (advanced)</summary>
                <small className="hint">
                  Shell scripts run at workspace lifecycle points. They receive{" "}
                  <code>$REPO_URL</code>, <code>$ISSUE_IDENTIFIER</code>, <code>$ISSUE_BRANCH</code>
                  , <code>$SYMPHONY_INSTALL_CMD</code>, and the hook name as{" "}
                  <code>$SYMPHONY_HOOK</code>. <code>after_create</code> only runs for fresh
                  workspaces, so existing ready workspaces are not reinitialized by saving hook
                  changes.
                </small>
                <label>
                  After create
                  <textarea
                    {...literalInputProps}
                    className="mono-input"
                    rows={4}
                    value={settings.hook_after_create ?? ""}
                    disabled={!runtimeAvailable}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        hook_after_create: nullable(e.currentTarget.value),
                      })
                    }
                  />
                  <small className="hint">
                    Runs once per fresh workspace — clone, branch, install. Changes affect the next
                    new workspace, not an existing ready workspace.
                  </small>
                </label>
                <label>
                  Before run
                  <textarea
                    {...literalInputProps}
                    className="mono-input"
                    rows={2}
                    value={settings.hook_before_run ?? ""}
                    disabled={!runtimeAvailable}
                    onChange={(e) =>
                      setSettings({ ...settings, hook_before_run: nullable(e.currentTarget.value) })
                    }
                  />
                </label>
                <label>
                  After run
                  <textarea
                    {...literalInputProps}
                    className="mono-input"
                    rows={2}
                    value={settings.hook_after_run ?? ""}
                    disabled={!runtimeAvailable}
                    onChange={(e) =>
                      setSettings({ ...settings, hook_after_run: nullable(e.currentTarget.value) })
                    }
                  />
                </label>
                <label>
                  Before remove
                  <textarea
                    {...literalInputProps}
                    className="mono-input"
                    rows={2}
                    value={settings.hook_before_remove ?? ""}
                    disabled={!runtimeAvailable}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        hook_before_remove: nullable(e.currentTarget.value),
                      })
                    }
                  />
                </label>
              </details>
            </section>
          </div>

          <div
            className="settings-stage settings-stage-workflow"
            id="settings-workflow"
            tabIndex={-1}
          >
            <Panel title="Default workflow">
              <PromptEditor
                id="settings-prompt-template"
                value={settings.prompt_template}
                seedRevision={promptSeedRevision}
                disabled={!runtimeAvailable}
                onChange={onPromptChange}
                aria-invalid={
                  validationState.status === "invalid" &&
                  validationFieldId(validationState.result) === "settings-prompt-template"
                }
                aria-describedby={
                  validationState.status === "invalid" &&
                  validationFieldId(validationState.result) === "settings-prompt-template"
                    ? "settings-validation-summary"
                    : undefined
                }
              />
              <div className="section-row">
                <button type="button" disabled={busy || !runtimeAvailable} onClick={onResetPrompt}>
                  Reset to default
                </button>
                <small className="hint">
                  Replaces the editor with the bundled default. Repositories with a valid
                  SYMPHONY-WORKFLOW.md override it; nothing changes until you save.
                </small>
              </div>
            </Panel>
          </div>
        </div>
      </div>

      {validation && runtimeAvailable ? (
        <div className="settings-footer">
          <div className="storage-actions">
            <button
              type="button"
              onClick={() => revealDesktopPath(validation.database_path).catch(() => undefined)}
            >
              Reveal database
            </button>
            <button
              type="button"
              onClick={() =>
                revealDesktopPath(`${validation.app_data_dir}/logs`).catch(() => undefined)
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
  id,
  value,
  onChange,
  disabled,
  separator,
  placeholder,
  rows,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  separator: "comma" | "newline";
  placeholder?: string;
  rows?: number;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const join = (items: string[]) => (separator === "comma" ? items.join(", ") : items.join("\n"));
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
        id={id}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        {...literalInputProps}
        className="mono-input"
        value={draft}
        disabled={disabled}
        rows={rows ?? 6}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.currentTarget.value)}
      />
    );
  }
  return (
    <input
      id={id}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      {...literalInputProps}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => handleChange(e.currentTarget.value)}
    />
  );
}

function EnvInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled: boolean;
}) {
  const joined = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, envValue]) => `${key}=${envValue}`)
    .join("\n");
  const [draft, setDraft] = useState(joined);
  const lastEmitted = useRef(joined);

  useEffect(() => {
    if (joined !== lastEmitted.current) {
      setDraft(joined);
      lastEmitted.current = joined;
    }
  }, [joined]);

  function parse(text: string): Record<string, string> {
    const next: Record<string, string> = {};
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const separator = line.indexOf("=");
      const key = (separator === -1 ? line : line.slice(0, separator)).trim();
      if (key === "") continue;
      next[key] = separator === -1 ? "" : line.slice(separator + 1);
    }
    return next;
  }

  function handleChange(text: string) {
    setDraft(text);
    const next = parse(text);
    lastEmitted.current = Object.entries(next)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, envValue]) => `${key}=${envValue}`)
      .join("\n");
    onChange(next);
  }

  return (
    <textarea
      id={id}
      {...literalInputProps}
      className="mono-input"
      value={draft}
      disabled={disabled}
      rows={4}
      placeholder={"OPENAI_API_KEY=...\nFEATURE_FLAG=1"}
      onChange={(e) => handleChange(e.currentTarget.value)}
    />
  );
}

const BACKEND_OPTIONS: Array<{ value: AppSettings["agent_backend"]; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "opencode", label: "opencode" },
];

const AGENT_CLI_OPTIONS = [
  {
    key: "codex",
    label: "Codex",
    defaultCommand: "codex",
    installUrl: "https://developers.openai.com/codex/cli",
  },
  {
    key: "claude",
    label: "Claude Code",
    defaultCommand: "claude",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
  },
  {
    key: "cursor",
    label: "Cursor",
    defaultCommand: "agent",
    installUrl: "https://cursor.com/docs/cli/installation",
  },
  {
    key: "opencode",
    label: "opencode",
    defaultCommand: "opencode",
    installUrl: "https://opencode.ai/docs/",
  },
] as const;

function AgentCliStatus({
  backend,
  validation,
}: {
  backend: AppSettings["agent_backend"];
  validation: ValidationResult;
}) {
  const { label, defaultCommand, installUrl } =
    AGENT_CLI_OPTIONS.find((option) => option.key === backend) ?? AGENT_CLI_OPTIONS[0];
  const found = validation[`${backend}_found`];
  const command = validation[`${backend}_command`];

  return (
    <section className="agent-cli-status-block" aria-label={`${label} CLI availability`}>
      <div className="agent-cli-status-row">
        <span>
          <strong>{label} CLI</strong>
          {command === defaultCommand ? null : <code>{command}</code>}
        </span>
        <span className={found ? "detect ok" : "detect missing"}>
          {found ? "Found" : "Not found"}
        </span>
        {!found ? (
          <button
            type="button"
            className="link-button outlined"
            onClick={() => openExternalUrl(installUrl).catch(() => undefined)}
          >
            Install {label}
          </button>
        ) : null}
      </div>
      <small className="hint">
        {found
          ? `Open ${label} CLI once to confirm you're signed in and a default model is configured.`
          : `After installing, open ${label} CLI once to sign in and choose a default model.`}
      </small>
    </section>
  );
}

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
  if (backend === "cursor") {
    return (
      <svg className="backend-icon" viewBox="600 300 400 400" aria-hidden="true">
        <path
          fill="#F7F7F4"
          d="M999.994 554.294C999.994 559.859 999.994 565.419 999.962 570.984C999.935 575.67 999.882 580.357 999.753 585.038C999.475 595.247 998.875 605.542 997.059 615.639C995.217 625.88 992.212 635.409 987.477 644.718C982.822 653.861 976.738 662.233 969.485 669.491C962.227 676.748 953.861 682.828 944.712 687.482C935.409 692.217 925.875 695.222 915.633 697.065C905.537 698.88 895.242 699.48 885.033 699.759C880.346 699.887 875.665 699.941 870.978 699.968C865.413 700.005 859.853 700 854.288 700H745.695C740.13 700 734.571 700 729.005 699.968C724.319 699.941 719.632 699.887 714.951 699.759C704.742 699.48 694.447 698.88 684.35 697.065C674.109 695.222 664.58 692.217 655.271 687.482C646.128 682.828 637.756 676.743 630.499 669.491C623.241 662.233 617.161 653.866 612.507 644.718C607.772 635.414 604.767 625.88 602.925 615.639C601.109 605.542 600.509 595.247 600.23 585.038C600.102 580.352 600.048 575.67 600.021 570.984C600 565.419 600 559.859 600 554.294V445.701C600 440.136 600 434.576 600.032 429.011C600.059 424.324 600.112 419.637 600.241 414.956C600.52 404.747 601.119 394.452 602.935 384.356C604.778 374.115 607.783 364.586 612.518 355.277C617.172 346.133 623.257 337.762 630.509 330.504C637.767 323.246 646.133 317.167 655.282 312.512C664.586 307.777 674.12 304.772 684.361 302.93C694.458 301.114 704.752 300.514 714.961 300.236C719.648 300.107 724.329 300.054 729.016 300.027C734.576 300 740.136 300 745.701 300H854.294C859.859 300 865.419 300 870.984 300.032C875.67 300.059 880.357 300.112 885.038 300.241C895.247 300.52 905.542 301.119 915.639 302.935C925.88 304.778 935.409 307.783 944.718 312.518C953.861 317.172 962.233 323.257 969.491 330.509C976.748 337.767 982.828 346.133 987.482 355.282C992.217 364.586 995.222 374.12 997.065 384.361C998.88 394.458 999.48 404.752 999.759 414.961C999.887 419.648 999.941 424.329 999.968 429.016C1000.01 434.581 1000 440.141 1000 445.706V554.299L999.994 554.294Z"
        />
        <path
          fill="#72716D"
          d="M800.001 500L928.151 573.986C927.364 575.352 926.223 576.515 924.809 577.329L805.025 646.484C801.913 648.279 798.078 648.279 794.966 646.484L675.182 577.329C673.768 576.515 672.627 575.347 671.84 573.986L799.99 500H800.001Z"
        />
        <path
          fill="#55544F"
          d="M800 352.165V500L671.85 573.987C671.062 572.621 670.623 571.046 670.623 569.418V430.582C670.623 427.314 672.364 424.304 675.192 422.67L794.97 353.515C796.529 352.615 798.264 352.165 800 352.165Z"
        />
        <path
          fill="#43413C"
          d="M928.15 426.013C927.363 424.647 926.222 423.485 924.808 422.67L805.024 353.515C803.471 352.615 801.735 352.165 800 352.165V500L928.15 573.987C928.938 572.621 929.377 571.046 929.377 569.418V430.582C929.377 428.948 928.943 427.384 928.15 426.013Z"
        />
        <path
          fill="#D6D5D2"
          d="M919.184 431.192C919.913 432.446 920.009 434.053 919.184 435.483L802.856 636.961C802.074 638.327 799.995 637.765 799.995 636.195V503.428C799.995 502.367 799.711 501.35 799.197 500.455L919.179 431.182H919.184V431.192Z"
        />
        <path
          fill="white"
          d="M919.184 431.192L799.202 500.466C798.694 499.577 797.949 498.827 797.028 498.291L682.054 431.91C680.688 431.128 681.251 429.05 682.82 429.05H915.467C917.117 429.05 918.461 429.944 919.179 431.198H919.184V431.192Z"
        />
      </svg>
    );
  }
  if (backend === "opencode") {
    // Official OpenCode logomark (opencode.ai/brand). Two-tone square glyph:
    // the inner fill uses currentColor so it adapts to light/dark like the
    // other backend icons, with the frame in a muted currentColor. The brand
    // paths span x:0-24, y:6-36; the viewBox crops that 24x30 content and
    // centers it in a square so the mark sits centered in the 16x16 icon box.
    return (
      <svg className="backend-icon" viewBox="-3 6 30 30" aria-hidden="true">
        <path fill="currentColor" fillOpacity="0.55" d="M18 30H6V18H18V30Z" />
        <path fill="currentColor" d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
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
    setActiveIndex(
      Math.max(
        0,
        BACKEND_OPTIONS.findIndex((option) => option.value === value),
      ),
    );
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
        aria-activedescendant={
          open ? `backend-option-${BACKEND_OPTIONS[activeIndex].value}` : undefined
        }
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
        <div className="icon-select-list" id="backend-listbox" role="listbox">
          {BACKEND_OPTIONS.map((option, index) => (
            <div
              key={option.value}
              id={`backend-option-${option.value}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              className={index === activeIndex ? "icon-select-option active" : "icon-select-option"}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => commit(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  commit(index);
                }
              }}
            >
              <span className="icon-select-check" aria-hidden="true">
                {option.value === value ? (
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
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
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PromptEditor({
  id,
  value,
  seedRevision,
  disabled,
  onChange,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  value: string;
  seedRevision: number;
  disabled: boolean;
  onChange: (next: string) => void;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  const lastEmitted = useRef(value);
  const lastSeedRevision = useRef(seedRevision);

  useEffect(() => {
    if (value !== lastEmitted.current || seedRevision !== lastSeedRevision.current) {
      setDraft(value);
      lastEmitted.current = value;
      lastSeedRevision.current = seedRevision;
    }
  }, [seedRevision, value]);

  function insertVariable(name: string) {
    const token = `{{${name}}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = draft.slice(0, start) + token + draft.slice(end);
    setDraft(next);
    lastEmitted.current = next;
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="prompt-editor">
      <textarea
        id={id}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        ref={ref}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => {
          const next = e.currentTarget.value;
          setDraft(next);
          lastEmitted.current = next;
          onChange(next);
        }}
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
          On retries, Symphony appends a <code>## Retry context</code> section with the prior run's
          error automatically.
        </p>
      </aside>
    </div>
  );
}

function WorkflowBlock({
  status,
  checking,
  transfer,
  transferRunning,
  settingsDirty,
  busy,
  runtimeAvailable,
  repoConfigured,
  onRefresh,
  onTransfer,
}: {
  status: RepoWorkflowStatus | null;
  checking: boolean;
  transfer: WorkflowTransferStatus | null;
  transferRunning: boolean;
  settingsDirty: boolean;
  busy: boolean;
  runtimeAvailable: boolean;
  repoConfigured: boolean;
  onRefresh: () => void;
  onTransfer: () => void;
}) {
  const transferring = transfer?.state === "running";
  const otherTransferRunning = transferRunning && !transferring;
  const prUrl =
    (transfer?.state === "completed" ? transfer.pr_url : null) ?? status?.pr_url ?? null;
  const actionDisabled =
    busy || transferRunning || settingsDirty || !runtimeAvailable || !repoConfigured;
  const checkDisabled = busy || transferRunning || !runtimeAvailable || !repoConfigured;

  let tone: "neutral" | "info" | "success" | "warning" | "error" = "neutral";
  let headline = "Check which workflow this repository uses.";
  let detail: React.ReactNode =
    "A workflow checked into the default branch overrides the saved default workflow for runs routed here.";
  let meta: React.ReactNode = null;
  let actions: React.ReactNode = null;

  const checkAgain = (
    <button type="button" disabled={checkDisabled} onClick={onRefresh}>
      Check again
    </button>
  );

  if (!repoConfigured) {
    headline = "Add a repository URL first.";
    detail = "Workflow detection and transfer PR creation run against the repo URL above.";
  } else if (transferring) {
    tone = "info";
    headline = "Creating a workflow PR.";
    detail =
      "Symphony is copying the saved default workflow into SYMPHONY-WORKFLOW.md on a temporary branch.";
    meta = transfer?.message ?? "Preparing transfer...";
    actions = (
      <button type="button" disabled>
        Creating PR...
      </button>
    );
  } else if (transfer?.state === "failed") {
    tone = "error";
    headline = "Workflow PR was not created.";
    detail = "Fix the reported Git or GitHub access problem, save Settings, and retry.";
    meta = transfer.error ?? "Transfer failed.";
    actions = (
      <button type="button" className="primary" disabled={actionDisabled} onClick={onTransfer}>
        Retry workflow PR
      </button>
    );
  } else if (checking) {
    tone = "info";
    headline = "Checking the default branch.";
    detail = "Symphony is looking for either supported workflow filename on GitHub.";
  } else if (status?.source === "repository") {
    tone = "success";
    headline = `Using ${status.filename ?? "the repository workflow"}.`;
    detail = "Future dispatches fetch this workflow from the repository default branch.";
    actions = checkAgain;
  } else if (prUrl) {
    tone = "warning";
    headline = "Using the default workflow until the PR merges.";
    detail = "A repository workflow transfer is waiting for review.";
    actions = (
      <>
        <button type="button" onClick={() => openExternalUrl(prUrl).catch(() => undefined)}>
          View PR
        </button>
        {checkAgain}
      </>
    );
  } else if (status?.source === "default") {
    tone = status.fallback_reason === "invalid" ? "warning" : "neutral";
    headline = "Using the saved default workflow.";
    detail = status.detail ?? "No valid repository workflow was found.";
    if (settingsDirty) {
      meta = "Save Settings before transferring the workflow currently used by the worker.";
    } else if (!status.can_transfer) {
      meta = "Transfer requires GitHub plus Git clone and push access.";
    }
    actions = (
      <>
        <button
          type="button"
          className="primary"
          disabled={actionDisabled || !status.can_transfer}
          onClick={onTransfer}
        >
          Transfer workflow to repo
        </button>
        {checkAgain}
      </>
    );
  } else if (status?.source === "unknown") {
    tone = "error";
    headline = "Symphony could not determine the workflow.";
    detail = status.detail ?? "Check the repository URL and GitHub authentication.";
    actions = (
      <button type="button" disabled={checkDisabled} onClick={onRefresh}>
        Check status
      </button>
    );
  } else {
    actions = (
      <button type="button" disabled={checkDisabled} onClick={onRefresh}>
        Check status
      </button>
    );
  }

  if (otherTransferRunning) {
    meta = "Another repository is already creating a workflow PR.";
  }

  return (
    <div className="field-group skills-field workflow-field">
      <div className="field-label-row">
        <span>Workflow</span>
      </div>
      <div className={`skills-install ${tone}`} aria-live="polite">
        <div className="skills-install-copy">
          <strong>{headline}</strong>
          <small>{detail}</small>
          {meta ? (
            <small
              className={tone === "error" ? "skills-install-detail error" : "skills-install-detail"}
            >
              {meta}
            </small>
          ) : null}
        </div>
        {actions ? <div className="skills-install-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

function SkillsBlock({
  status,
  checking,
  manuallyInstalled,
  install,
  installRunning,
  busy,
  runtimeAvailable,
  repoConfigured,
  onRefresh,
  onInstall,
  onMarkInstalled,
  onUseAutomaticCheck,
}: {
  /// Status and install are this card's repo only; installRunning is true
  /// while ANY repo's install session runs (the installer is one-at-a-time).
  status: SkillsStatus | null;
  checking: boolean;
  manuallyInstalled: boolean;
  install: SkillsInstallStatus | null;
  installRunning: boolean;
  busy: boolean;
  runtimeAvailable: boolean;
  repoConfigured: boolean;
  onRefresh: () => void;
  onInstall: () => void;
  onMarkInstalled: () => void;
  onUseAutomaticCheck: () => void;
}) {
  const installing = install?.state === "running";
  const otherInstallRunning = installRunning && !installing;
  const actionsDisabled = busy || installRunning || !runtimeAvailable || !repoConfigured;
  const manualActionsDisabled = busy || !runtimeAvailable || !repoConfigured;
  // A just-finished install knows the PR URL before the next status check does.
  const prUrl = (install?.state === "completed" ? install.pr_url : null) ?? status?.pr_url ?? null;

  let tone: "neutral" | "info" | "success" | "warning" | "error" = "neutral";
  let headline = "Check this repo for Symphony skills.";
  let detail: React.ReactNode =
    "Symphony can detect whether this repo already ships the bundled agent skills; missing skills are injected locally for issue runs.";
  let meta: React.ReactNode = null;
  let actions: React.ReactNode = null;

  const checkButton = (
    <button type="button" disabled={actionsDisabled} onClick={onRefresh}>
      Check status
    </button>
  );
  const checkAgainButton = (
    <button type="button" disabled={actionsDisabled} onClick={onRefresh}>
      Check again
    </button>
  );
  const markInstalledButton = (
    <button type="button" disabled={manualActionsDisabled} onClick={onMarkInstalled}>
      Mark installed
    </button>
  );

  if (manuallyInstalled) {
    tone = "success";
    headline = "Agent skills are marked installed.";
    detail =
      "Symphony will stop warning when this repo does not match the exact bundled skill set.";
    meta = "Use automatic check to compare the default branch against the bundled manifests again.";
    actions = (
      <button type="button" disabled={manualActionsDisabled} onClick={onUseAutomaticCheck}>
        Use automatic check
      </button>
    );
  } else if (installing) {
    tone = "info";
    headline = "Creating an install PR.";
    detail =
      "Symphony is working in a temporary checkout, writing the bundled skills, adapting validation commands, and opening a PR.";
    meta = install?.message ?? "Preparing install session...";
    actions = (
      <button type="button" disabled>
        Creating PR...
      </button>
    );
  } else if (install?.state === "failed") {
    tone = "error";
    headline = "Install PR was not created.";
    detail = "Fix the reported GitHub or agent access problem, then retry the install session.";
    meta = install.error ?? "Install failed.";
    actions = (
      <button type="button" className="primary" disabled={actionsDisabled} onClick={onInstall}>
        Retry install PR
      </button>
    );
  } else if (checking) {
    tone = "info";
    headline = "Checking the default branch.";
    detail = "Symphony is using GitHub to verify the bundled skill manifests.";
  } else if (status?.state === "installed") {
    tone = "success";
    headline = "Agent skills are installed.";
    detail = `All ${BUNDLED_SKILL_COUNT} Symphony skills are present on this repo's default branch.`;
    actions = checkAgainButton;
  } else if (prUrl) {
    tone = "warning";
    headline = "An install PR is waiting for review.";
    detail = "Symphony will inject local fallback skills until the PR lands on the default branch.";
    actions = (
      <>
        <button type="button" onClick={() => openExternalUrl(prUrl).catch(() => undefined)}>
          View PR
        </button>
        {markInstalledButton}
        {checkAgainButton}
      </>
    );
  } else if (status?.state === "missing") {
    tone = "warning";
    headline = "Repository does not ship all agent skills.";
    detail = `Issue runs will get local fallback copies. Create an install PR for ${BUNDLED_SKILL_EXAMPLES}, and the rest of the bundled workflow skills, if this repo should check them in.`;
    meta = `${status.missing.length} of ${BUNDLED_SKILL_COUNT} bundled skills are missing.`;
    actions = (
      <>
        <button type="button" className="primary" disabled={actionsDisabled} onClick={onInstall}>
          Create install PR
        </button>
        {markInstalledButton}
        {checkAgainButton}
      </>
    );
  } else if (status?.state === "unavailable") {
    tone = "error";
    headline = "Symphony could not check this repo.";
    detail = status.detail ?? "Check the repository URL, GitHub CLI, and authentication.";
    actions = (
      <>
        {checkButton}
        {markInstalledButton}
      </>
    );
  } else if (!repoConfigured) {
    headline = "Add a repository URL first.";
    detail = "Skill detection and install PR creation run against the repo URL above.";
  } else {
    actions = (
      <>
        {checkButton}
        {markInstalledButton}
      </>
    );
  }

  if (otherInstallRunning) {
    meta = (
      <>
        {meta ? <span>{meta}</span> : null}
        <span>Another repository is already creating an install PR.</span>
      </>
    );
  }

  return (
    <div className="field-group skills-field">
      <div className="field-label-row">
        <span>Agent skills</span>
      </div>
      <div className={`skills-install ${tone}`} aria-live="polite">
        <div className="skills-install-copy">
          <strong>{headline}</strong>
          <small>{detail}</small>
          {meta ? (
            <small
              className={tone === "error" ? "skills-install-detail error" : "skills-install-detail"}
            >
              {meta}
            </small>
          ) : null}
        </div>
        {actions ? <div className="skills-install-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="inline-link"
      onClick={() => openExternalUrl(href).catch(() => undefined)}
    >
      {children}
    </button>
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

export function SettingsHeaderActions({
  validation,
  dirty,
  savedFlash,
  workerRunning,
  workerConfigError,
  liveReconfigureSkipped,
  busy,
  runtimeAvailable,
}: {
  validation: ValidationResult | null;
  dirty: boolean;
  savedFlash: boolean;
  workerRunning: boolean;
  workerConfigError: boolean;
  liveReconfigureSkipped: boolean;
  busy: boolean;
  runtimeAvailable: boolean;
}) {
  // Only surface blocking validation errors here. Incomplete-setup messages
  // (e.g. no repo configured yet) are shown by the setup checklist, not flagged
  // red next to Save while the user is still working through setup.
  const validationError = validation?.workflow_blocking ? validation.workflow_error : null;
  const status =
    validationError ??
    (savedFlash
      ? workerRunning
        ? workerConfigError || liveReconfigureSkipped
          ? "Saved; worker kept previous config"
          : "Saved; future runs use changes"
        : "Saved"
      : dirty
        ? "Unsaved changes"
        : "");
  const statusClass =
    validationError || (savedFlash && (workerConfigError || liveReconfigureSkipped))
      ? "save-status invalid"
      : savedFlash
        ? "save-status ok"
        : "save-status";

  return (
    <section className="settings-header-actions" aria-label="Settings actions">
      <div className="settings-action-row">
        <span className={statusClass} aria-live="polite">
          {status}
        </span>
        <button
          disabled={busy || !runtimeAvailable || !dirty}
          className="primary"
          form={SETTINGS_FORM_ID}
          type="submit"
        >
          Save
        </button>
      </div>
    </section>
  );
}

export default SettingsFeature;
