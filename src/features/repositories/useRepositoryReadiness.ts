import { useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  RepoWorkflowStatus,
  SkillsInstallStatus,
  SkillsStatus,
  WorkflowTransferStatus,
} from "../../bindings";
import * as desktopCommands from "../../desktop/commands";
import { createPollController } from "../../pollController";
import {
  configuredRepoUrls,
  skillsCheckContextKey,
  stableSessionEnvKey,
} from "../shared/configuration";
import type { RunDesktopAction } from "../shared/useDesktopActions";
import { usePollingStatus } from "../shared/usePollingStatus";

type Options = {
  runtimeAvailable: boolean;
  visible: boolean;
  settings: AppSettings | null;
  readDraft: () => AppSettings | null;
  run: RunDesktopAction;
};
export function useRepositoryReadiness(options: Options) {
  const { runtimeAvailable, visible, settings, run: call } = options;
  const context = useRef(options);
  context.current = options;
  const { pollingStates, updatePollingState, clearPollingState } = usePollingStatus<
    "skillsInstall" | "workflowTransfer"
  >();
  const workflowReadinessDirtyRef = useRef(false);
  const [skillsStatuses, setSkillsStatuses] = useState<Record<string, SkillsStatus>>({});
  const [skillsChecking, setSkillsChecking] = useState<Record<string, boolean>>({});
  const [skillsInstall, setSkillsInstall] = useState<SkillsInstallStatus | null>(null);
  const [workflowStatuses, setWorkflowStatuses] = useState<Record<string, RepoWorkflowStatus>>({});
  const [workflowReadinessEpoch, setWorkflowReadinessEpoch] = useState(0);
  const [workflowChecking, setWorkflowChecking] = useState<Record<string, boolean>>({});
  const [workflowTransfer, setWorkflowTransfer] = useState<WorkflowTransferStatus | null>(null);
  const skillsCheckSeq = useRef<Record<string, number>>({});
  const skillsCheckContext = useRef<Record<string, string>>({});
  const skillsInstallSettingsRef = useRef<AppSettings | null>(null);
  const workflowCheckSeq = useRef<Record<string, number>>({});
  const workflowCheckContext = useRef<Record<string, string>>({});
  const repoStatusRefreshTimer = useRef<number | null>(null);
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
  const queueRefresh = (target: AppSettings) => {
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: saved settings changes schedule checks; queueRefresh uses their current context.
  useEffect(() => {
    if (!settings || savedRepoStatusKey === null) return;
    const target = context.current.readDraft() ?? settings;
    queueRefresh(target);
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

    controller.start();
    return () => {
      controller.dispose();
      clearPollingState("skillsInstall");
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

    controller.start();
    return () => {
      controller.dispose();
      clearPollingState("workflowTransfer");
    };
  }, [clearPollingState, runtimeAvailable, updatePollingState, workflowTransfer?.state]);

  // Repo skill detection does not depend on the selected agent or its command,
  // so it only needs refreshing when Settings are entered or first loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: entering Settings or first loading settings are the deliberate refresh triggers.
  useEffect(() => {
    if (!runtimeAvailable || !visible || !settings) return;
    const target = context.current.readDraft() ?? settings;
    refreshSkillsStatus(target);
    refreshWorkflowStatus(target);
  }, [visible, runtimeAvailable, settings !== null]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: readiness epoch and visibility are explicit scheduling signals; checks use current settings.
  useEffect(() => {
    if (!visible || !settings || !workflowReadinessDirtyRef.current) return;
    workflowReadinessDirtyRef.current = false;
    refreshWorkflowStatus();
  }, [visible, settings !== null, workflowReadinessEpoch]);
  return {
    state: {
      skillsStatuses,
      skillsChecking,
      skillsInstall,
      workflowStatuses,
      workflowChecking,
      workflowTransfer,
    },
    pollingStates,
    checkSkills: checkRepoSkills,
    installSkills: startSkillsInstall,
    checkWorkflow: checkRepoWorkflow,
    transferWorkflow: startWorkflowTransfer,
    queueRefresh,
    invalidateWorkflow() {
      workflowReadinessDirtyRef.current = true;
      setWorkflowReadinessEpoch((epoch) => epoch + 1);
    },
    initializePreview(preview: {
      skillsStatuses: Record<string, SkillsStatus>;
      workflowStatuses: Record<string, RepoWorkflowStatus>;
    }) {
      setSkillsStatuses(preview.skillsStatuses);
      setWorkflowStatuses(preview.workflowStatuses);
    },
  };
}
export type RepositoryReadiness = ReturnType<typeof useRepositoryReadiness>;
