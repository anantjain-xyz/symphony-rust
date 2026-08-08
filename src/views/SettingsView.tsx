import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import * as desktopCommands from "../desktop/commands";
import { getDesktopVersion, openExternalUrl, revealDesktopPath } from "../desktop/shell";
import type { InputHTMLAttributes } from "react";
import type {
  AppSettings,
  LinearViewerProfile,
  RepoConfig,
  RepoWorkflowStatus,
  SkillFile,
  SkillsInstallStatus,
  SkillsStatus,
  TrackerTestResult,
  ValidationResult,
  WorkflowTransferStatus,
} from "../bindings";
import { SettingsValidationController } from "../settingsValidationController";
import type { SettingsValidationState } from "../settingsValidationController";
import { nullable } from "../format";
import { formSnapshot, Panel } from "../viewPrimitives";
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

export function settingsNavigationOffset({
  compact,
  viewportPaddingTop,
  stickyTop,
  stepperHeight,
  layoutGap,
}: {
  compact: boolean;
  viewportPaddingTop: number;
  stickyTop: number;
  stepperHeight: number;
  layoutGap: number;
}): number {
  return compact ? Math.max(24, viewportPaddingTop + stickyTop + stepperHeight + layoutGap) : 24;
}

export function settingsSectionForScrollPosition({
  viewportTop,
  activationOffset,
  scrollTop,
  clientHeight,
  scrollHeight,
  sectionTops,
}: {
  viewportTop: number;
  activationOffset: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  sectionTops: Partial<Record<SettingsSectionId, number>>;
}): SettingsSectionId {
  const maxScrollTop = scrollHeight - clientHeight;
  if (maxScrollTop > 1 && scrollTop >= maxScrollTop - 1) {
    return SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id;
  }
  const activationLine = viewportTop + activationOffset;
  let current: SettingsSectionId = SETTINGS_SECTIONS[0].id;
  for (const section of SETTINGS_SECTIONS) {
    const top = sectionTops[section.id];
    if (top !== undefined && top <= activationLine + 1) current = section.id;
  }
  return current;
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

export function defaultSkillDescription(content: string): string | null {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") return null;
    const match = line.match(/^description:\s*(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

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
    const next = dirtyRef.current ? (draftRef.current ?? draft) : savedSettings;
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
    const layout = viewport.querySelector<HTMLElement>(".settings-layout");
    const stepper = layout?.querySelector<HTMLElement>(".settings-sidebar");
    let frame: number | null = null;
    const updateNavigationOffset = () => {
      const parsedViewportPadding = Number.parseFloat(window.getComputedStyle(viewport).paddingTop);
      const parsedStickyTop = stepper
        ? Number.parseFloat(window.getComputedStyle(stepper).top)
        : Number.NaN;
      const parsedGap = layout
        ? Number.parseFloat(window.getComputedStyle(layout).rowGap)
        : Number.NaN;
      const offset = settingsNavigationOffset({
        compact: window.innerWidth <= 900,
        viewportPaddingTop: Number.isFinite(parsedViewportPadding) ? parsedViewportPadding : 0,
        stickyTop: Number.isFinite(parsedStickyTop) ? parsedStickyTop : 0,
        stepperHeight: stepper?.offsetHeight ?? 0,
        layoutGap: Number.isFinite(parsedGap) ? parsedGap : 0,
      });
      layout?.style.setProperty("--settings-navigation-offset", `${offset}px`);
      return offset;
    };
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
          activationOffset: updateNavigationOffset(),
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
    window.addEventListener("resize", onScroll);
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !stepper ? null : new ResizeObserver(onScroll);
    if (stepper) resizeObserver?.observe(stepper);
    updateActiveSection();
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      resizeObserver?.disconnect();
      layout?.style.removeProperty("--settings-navigation-offset");
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
          is_default: false,
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
              <label htmlFor="linear-team-filters">
                Linear teams
                <ListInput
                  id="linear-team-filters"
                  value={settings.tracker_team_keys}
                  disabled={!runtimeAvailable}
                  separator="comma"
                  onChange={(tracker_team_keys) => setSettings({ ...settings, tracker_team_keys })}
                  placeholder="ENG, WAL"
                />
                <small className="hint">
                  Optional. Match any listed team. When projects are also set, an issue must match
                  both filters.
                </small>
              </label>
              <label htmlFor="linear-project-filters">
                Linear projects
                <ListInput
                  id="linear-project-filters"
                  value={settings.tracker_project_ids}
                  disabled={!runtimeAvailable}
                  separator="comma"
                  onChange={(tracker_project_ids) =>
                    setSettings({ ...settings, tracker_project_ids })
                  }
                  placeholder="Project URLs or IDs"
                />
                <small className="hint">
                  Optional. Match any listed project. When teams are also set, an issue must match
                  both filters.
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
                label in Linear wins, then the default. Clear the default to require a repository
                label.
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
              <label>
                Backend
                <select
                  value={settings.agent_backend}
                  disabled={!runtimeAvailable}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      agent_backend: event.currentTarget.value as AppSettings["agent_backend"],
                    })
                  }
                >
                  {BACKEND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {validation ? (
                <AgentCliStatus backend={settings.agent_backend} validation={validation} />
              ) : null}
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
                    Permission mode
                    <select
                      value={settings.codex_permission_mode}
                      disabled={!runtimeAvailable}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          codex_permission_mode: e.currentTarget
                            .value as AppSettings["codex_permission_mode"],
                        })
                      }
                    >
                      <option value="approve-for-me">Approve for me (Auto-review)</option>
                      <option value="full-access">Full Access</option>
                    </select>
                    <small className="hint">
                      <code>Approve for me</code> keeps the sandbox and sends boundary crossings to
                      Codex Auto-review. <code>Full Access</code> bypasses approvals and the
                      sandbox.
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
            <Panel title="Default agent skills">
              <DefaultSkillsReference runtimeAvailable={runtimeAvailable} />
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

export function DefaultSkillsReference({ runtimeAvailable }: { runtimeAvailable: boolean }) {
  const [visible, setVisible] = useState(false);
  const [skills, setSkills] = useState<SkillFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function loadDefaultSkills() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const loaded = await desktopCommands.getDefaultSkills();
      if (mountedRef.current) setSkills(loaded);
    } catch (loadError) {
      if (mountedRef.current) setError(String(loadError));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  function toggleVisible() {
    if (visible) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (skills === null && runtimeAvailable) void loadDefaultSkills();
  }

  return (
    <div className="default-skills-reference">
      <div className="default-skills-intro">
        <div>
          <h4>Bundled, read-only instructions</h4>
          <p className="hint">
            Symphony supplies these defaults to issue runs when a repository does not provide its
            own copy. Repository skills can adapt them to that codebase.
          </p>
        </div>
        <button
          type="button"
          aria-expanded={visible}
          aria-controls="default-skills-list"
          disabled={!runtimeAvailable}
          onClick={toggleVisible}
        >
          {visible ? "Hide default skills" : `View ${BUNDLED_SKILL_COUNT} default skills`}
        </button>
      </div>
      {visible ? (
        <div id="default-skills-list" className="default-skills-list" aria-busy={loading}>
          {loading ? <p className="default-skills-state hint">Loading default skills...</p> : null}
          {error ? (
            <div className="default-skills-state default-skills-error" role="alert">
              <p>Could not load the bundled skills. {error}</p>
              <button type="button" onClick={() => void loadDefaultSkills()}>
                Try again
              </button>
            </div>
          ) : null}
          {skills?.map((skill) => {
            const description = defaultSkillDescription(skill.content);
            return (
              <details className="default-skill" key={skill.name}>
                <summary>
                  <span className="default-skill-summary">
                    <code>{skill.name}</code>
                    {description ? <small>{description}</small> : null}
                  </span>
                </summary>
                <section className="default-skill-content" aria-label={`${skill.name} contents`}>
                  <pre>
                    <code>{skill.content}</code>
                  </pre>
                </section>
              </details>
            );
          })}
          {skills?.length === 0 ? (
            <p className="default-skills-state hint">No default skills are bundled.</p>
          ) : null}
        </div>
      ) : null}
    </div>
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
