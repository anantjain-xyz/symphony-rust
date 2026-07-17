// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { retroRepoBatchState } from "./App";
import type {
  AppSettings,
  IssueRow,
  Overview,
  RetroBatchRow,
  RunWithIssueRow,
  SkillsStatus,
  RepoWorkflowStatus,
  ValidationResult,
  WorkerStatus,
} from "./bindings";

const tauriMocks = vi.hoisted(() => ({
  runtimeAvailable: false,
  getVersion: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: tauriMocks.getVersion,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: () => tauriMocks.runtimeAvailable,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: tauriMocks.openUrl,
  revealItemInDir: tauriMocks.revealItemInDir,
}));

function testSettings(): AppSettings {
  return {
    prompt_template: "Prompt",
    repos: [
      {
        name: "widgets",
        url: "git@github.com:acme/widgets.git",
        install_cmd: null,
        team_prefixes: ["ENG"],
        project_ids: [],
        is_default: true,
        skills_marked_installed: false,
      },
    ],
    workspace_root: null,
    tracker_workspace: "acme",
    tracker_prefix: null,
    tracker_project_id: null,
    tracker_assigned_to_me: false,
    active_states: ["Todo"],
    terminal_states: ["Done"],
    polling_interval_ms: 60_000,
    max_concurrent_agents: 1,
    max_retry_backoff_ms: 300_000,
    hook_after_create: null,
    hook_before_run: null,
    hook_after_run: null,
    hook_before_remove: null,
    hook_timeout_ms: 30_000,
    agent_backend: "codex",
    codex_command: null,
    claude_command: null,
    turn_timeout_ms: 3_600_000,
    session_env: {},
    codex_approval_policy: "never",
    codex_thread_sandbox: "workspace-write",
    codex_turn_sandbox_policy: "inherit",
    codex_network_access: true,
    claude_permission_mode: "auto",
    claude_allowed_tools: [],
    claude_disallowed_tools: [],
    claude_add_dirs: [],
    cursor_command: null,
    cursor_mode: "agent",
    cursor_force: true,
    cursor_trust: true,
    cursor_approve_mcps: false,
    cursor_sandbox: "enabled",
    cursor_model: null,
    opencode_command: null,
    opencode_model: null,
    opencode_agent: null,
    opencode_skip_permissions: true,
    linear_api_key_set: false,
  };
}

function expectLiteralInput(element: Element) {
  expect(element.getAttribute("autocomplete")).toBe("off");
  expect(element.getAttribute("autocorrect")).toBe("off");
  expect(element.getAttribute("autocapitalize")).toBe("none");
  expect(element.getAttribute("spellcheck")).toBe("false");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

// A `tauri.invoke` stand-in for the settings screen: it serves the commands the
// dashboard issues on load and lets each test vary only what it cares about —
// the validation verdict and whether saving is allowed.
function settingsInvoke({
  settings,
  validation,
  allowSave = false,
}: {
  settings: AppSettings;
  validation: Pick<ValidationResult, "workflow_ok" | "workflow_blocking" | "workflow_error">;
  allowSave?: boolean;
}) {
  return async (command: string) => {
    switch (command) {
      case "load_settings":
        return settings;
      case "get_overview":
        return {
          active_runs: [],
          retry_queue: [],
          recent_failures: [],
          live_sessions: [],
          worker_heartbeat: null,
          rate_limits: [],
          token_usage: [],
        };
      case "list_runs":
      case "list_issues":
      case "list_retros":
        return [];
      case "get_retro_status":
        return {
          state: "idle",
          retro_id: null,
          message: null,
          report: null,
          error: null,
        };
      case "get_retro_detail":
        return null;
      case "has_in_progress_retro_batches":
        return false;
      case "get_worker_status":
        return { state: "stopped", started_at: null, last_error: null };
      case "validate_settings":
        return {
          ...validation,
          codex_found: true,
          claude_found: true,
          cursor_found: true,
          opencode_found: true,
          codex_command: "codex",
          claude_command: "claude",
          cursor_command: "agent",
          opencode_command: "opencode",
          app_data_dir: "/tmp/symphony",
          database_path: "/tmp/symphony/symphony.db",
        };
      case "get_linear_viewer":
        return {
          id: "user-1",
          username: "alice",
          display_name: "Alice",
          email: "alice@example.com",
        };
      case "save_settings":
        if (!allowSave) {
          throw new Error("save_settings should not run after failed validation");
        }
        return { ...settings, linear_api_key_set: true };
      default:
        throw new Error(`Unhandled command: ${command}`);
    }
  };
}

function dashboardInvoke({
  settings,
  issues = [],
  overview = {
    active_runs: [],
    retry_queue: [],
    recent_failures: [],
    live_sessions: [],
    worker_heartbeat: null,
    rate_limits: [],
    token_usage: [],
  },
  skillsStatus = {
    state: "missing",
    missing: ["symphony-workpad"],
    pr_url: null,
    detail: null,
  },
  workflowStatus = {
    source: "default",
    filename: null,
    fallback_reason: "missing",
    detail: "No repository workflow was found on the default branch.",
    pr_url: null,
    can_transfer: true,
  },
  validation = {
    workflow_ok: true,
    workflow_blocking: false,
    workflow_error: null,
  },
  workerStatus = {
    state: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    last_error: null,
  },
}: {
  settings: AppSettings;
  issues?: IssueRow[];
  overview?: Overview;
  skillsStatus?: SkillsStatus;
  workflowStatus?: RepoWorkflowStatus;
  validation?: Partial<ValidationResult> &
    Pick<ValidationResult, "workflow_ok" | "workflow_blocking" | "workflow_error">;
  workerStatus?: WorkerStatus;
}) {
  return async (
    command: string,
    args?: { request?: { settings: AppSettings }; settings?: AppSettings },
  ) => {
    switch (command) {
      case "load_settings":
        return settings;
      case "get_overview":
        return overview;
      case "list_runs":
        return [];
      case "list_issues":
        return issues;
      case "list_retros":
        return [];
      case "get_retro_status":
        return {
          state: "idle",
          retro_id: null,
          message: null,
          report: null,
          error: null,
        };
      case "get_retro_detail":
        return null;
      case "has_in_progress_retro_batches":
        return false;
      case "get_worker_status":
        return workerStatus;
      case "trigger_retry_now":
        return true;
      case "get_skills_status":
        return skillsStatus;
      case "get_repo_workflow_status":
        return workflowStatus;
      case "validate_settings":
        return {
          codex_found: true,
          claude_found: true,
          cursor_found: true,
          opencode_found: true,
          codex_command: "codex",
          claude_command: "claude",
          cursor_command: args?.settings?.cursor_command ?? "agent",
          opencode_command: "opencode",
          app_data_dir: "/tmp/symphony",
          database_path: "/tmp/symphony/symphony.db",
          ...validation,
        };
      case "get_linear_viewer":
        return {
          id: "user-1",
          username: "alice",
          display_name: "Alice",
          email: "alice@example.com",
        };
      case "save_settings":
        return { ...(args?.request?.settings ?? settings) };
      default:
        throw new Error(`Unhandled command: ${command}`);
    }
  };
}

function issueRow({
  id,
  identifier,
  title,
  state,
  blockers = [],
}: {
  id: string;
  identifier: string;
  title: string;
  state: string;
  blockers?: string[];
}): IssueRow {
  return {
    id,
    identifier,
    title,
    description: null,
    priority: 2,
    state,
    branch: null,
    labels: "[]",
    blockers: JSON.stringify(blockers),
    pr_urls: "[]",
    raw: JSON.stringify({
      id,
      identifier,
      title,
      description: null,
      priority: 2,
      state,
      branch: null,
      labels: [],
      blockers,
      pr_urls: [],
      project_id: null,
      project_slug_id: null,
    }),
    last_seen_at: "2026-01-01T00:00:00.000Z",
  };
}

function runRow(overrides: Partial<RunWithIssueRow> = {}): RunWithIssueRow {
  return {
    id: "run-1",
    issue_id: "issue-sym-1",
    run_number: 1,
    workspace_path: "/tmp/symphony/workspaces/widgets/SYM-1",
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    error_class: null,
    error_message: null,
    worker_pid: 123,
    session_info: null,
    repo_name: "widgets",
    created_at: "2026-01-01T00:00:00.000Z",
    issue_identifier: "SYM-1",
    issue_title: "Build widgets",
    issue_state: "Todo",
    ...overrides,
  };
}

describe("App settings", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    tauriMocks.runtimeAvailable = false;
    tauriMocks.getVersion.mockResolvedValue("0.0.0-test");
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    tauriMocks.listen.mockResolvedValue(vi.fn());
    tauriMocks.openUrl.mockReset();
    tauriMocks.revealItemInDir.mockReset();

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const localStorageItems = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => localStorageItems.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) =>
          localStorageItems.set(key, value),
        ),
        removeItem: vi.fn((key: string) => localStorageItems.delete(key)),
        clear: vi.fn(() => localStorageItems.clear()),
      },
    });
  });

  it("reviews exact Retro diffs and gates change batches until every suggestion is decided", () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Retro" }));

    expect(
      Array.from(
        screen
          .getByRole("group", { name: "Filter suggestions" })
          .querySelectorAll("button"),
      ).map((button) => button.textContent),
    ).toEqual(["Pending", "Accepted", "Rejected", "All"]);
    expect(
      screen.getByRole("button", { name: "Pending" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getAllByLabelText("Proposed unified diff")).toHaveLength(4);
    expect(screen.getByText("0 of 4 reviewed")).toBeTruthy();
    const metadata = container.querySelectorAll(".retro-suggestion-badges");
    expect(Array.from(metadata[0].children).map((item) => item.textContent)).toEqual([
      "skill",
      "medium",
      "3 occurrences",
    ]);
    expect(Array.from(metadata[2].children).map((item) => item.textContent)).toEqual([
      "prompt",
      "low",
      "1 occurrence",
    ]);
    expect(metadata[0].children[1].classList.contains("medium")).toBe(true);
    expect(metadata[1].children[1].classList.contains("high")).toBe(true);
    expect(metadata[2].children[1].classList.contains("low")).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]);

    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);

    expect(screen.getByText("4 of 4 reviewed")).toBeTruthy();
    expect(screen.getByText("Review complete")).toBeTruthy();
    expect(screen.getByText("No pending suggestions")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(
      screen.getAllByText("Accepted", { selector: ".retro-decision-label.accepted" }),
    ).toHaveLength(2);
    expect(
      screen.getAllByText("Rejected", { selector: ".retro-decision-label.rejected" }),
    ).toHaveLength(2);
    const acceptedUndoButtons = screen.getAllByRole("button", {
      name: "Undo accepted decision",
    });
    expect(acceptedUndoButtons).toHaveLength(2);
    expect(acceptedUndoButtons[0].textContent).toBe("");
    expect(
      screen.getAllByRole("button", { name: "Undo rejected decision" }),
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Apply default workflow (1)" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Create 1 implementation PR" })
        .getAttribute("disabled"),
    ).not.toBeNull();

    fireEvent.click(acceptedUndoButtons[0]);
    expect(screen.getByText("3 of 4 reviewed")).toBeTruthy();
  });

  it("explains when a Retro suggestion filter has no matching suggestions", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Retro" }));
    fireEvent.click(screen.getByRole("button", { name: "Accepted" }));

    expect(screen.getByText("No accepted suggestions")).toBeTruthy();
    expect(
      screen.getByText(
        "Accept a pending suggestion to include it in an implementation batch.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rejected" }));
    expect(screen.getByText("No rejected suggestions")).toBeTruthy();
    expect(screen.getByText("Suggestions you reject will appear here.")).toBeTruthy();
  });

  it("deletes a selected Retro only after confirmation", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Retro" }));
    expect(
      screen.getAllByRole("button", { name: /Open retro from/ }),
    ).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Delete retro" }));
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /Open retro from/ }),
    ).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(
      screen.getAllByRole("button", { name: /Open retro from/ }),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delete retro" })).toBeTruthy();
  });

  it("scopes Retro PR locks to the repository whose batch succeeded", () => {
    const batch = (repoName: string, state: string): RetroBatchRow => ({
      id: `${repoName}-${state}`,
      retro_id: "retro-1",
      kind: "repo_pr",
      repo_name: repoName,
      repo_url: `https://github.com/acme/${repoName}.git`,
      base_ref: "abc123",
      state,
      progress: null,
      error: state === "failed" ? "network error" : null,
      pr_url: state === "completed" ? `https://github.com/acme/${repoName}/pull/1` : null,
      created_at: "2026-01-01T00:00:00.000Z",
      completed_at: state === "running" ? null : "2026-01-01T00:01:00.000Z",
    });
    const batches = [batch("widgets", "completed"), batch("api", "failed")];

    expect(retroRepoBatchState(batches, "widgets")).toBe("locked");
    expect(retroRepoBatchState(batches, "api")).toBe("available");
    expect(retroRepoBatchState([batch("api", "stale")], "api")).toBe("stale");
  });

  it("starts Retros from saved backend settings instead of sending form edits", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true };
    const baseInvoke = dashboardInvoke({ settings });
    tauriMocks.invoke.mockImplementation(async (command, args) => {
      if (command === "start_retro") {
        return {
          state: "running",
          retro_id: "retro-saved-settings",
          message: "Preparing retro window...",
          report: null,
          error: null,
        };
      }
      return baseInvoke(command, args);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Retro" }));
    const generateButton = screen
      .getAllByRole("button", { name: "Generate retro" })
      .find((button) => button.classList.contains("primary"));
    expect(generateButton).toBeTruthy();
    fireEvent.click(generateButton!);

    await waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith("start_retro"));
  });

  it("bounds dashboard commands when Tauri refresh events burst during a request", async () => {
    vi.useFakeTimers();
    try {
      tauriMocks.runtimeAvailable = true;
      const settings = testSettings();
      const firstOverview = deferred<Overview>();
      const baseInvoke = dashboardInvoke({ settings });
      let overviewRequests = 0;
      tauriMocks.invoke.mockImplementation((command, args) => {
        if (command === "get_overview" && overviewRequests++ === 0) {
          return firstOverview.promise;
        }
        return baseInvoke(command, args);
      });
      const eventListeners = new Map<string, () => void>();
      const unlisten = vi.fn();
      tauriMocks.listen.mockImplementation(async (event, listener) => {
        eventListeners.set(event, listener);
        return unlisten;
      });

      const rendered = render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(tauriMocks.invoke).toHaveBeenCalledWith("get_overview");
      expect([...eventListeners.keys()].sort()).toEqual([
        "agent_event",
        "db_changed",
        "rate_limit_changed",
      ]);

      act(() => {
        for (let index = 0; index < 10; index += 1) {
          eventListeners.get("db_changed")!();
          eventListeners.get("agent_event")!();
          eventListeners.get("rate_limit_changed")!();
        }
        vi.advanceTimersByTime(300);
      });

      firstOverview.resolve({
        active_runs: [],
        retry_queue: [],
        recent_failures: [],
        live_sessions: [],
        worker_heartbeat: null,
        rate_limits: [],
        token_usage: [],
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      for (const command of [
        "get_overview",
        "list_runs",
        "list_issues",
        "get_retro_status",
        "list_retros",
        "has_in_progress_retro_batches",
      ]) {
        expect(
          tauriMocks.invoke.mock.calls.filter(([called]) => called === command),
          command,
        ).toHaveLength(2);
      }
      rendered.unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(unlisten).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pin an error banner for a transient background refresh failure", async () => {
    vi.useFakeTimers();
    try {
      tauriMocks.runtimeAvailable = true;
      const settings = testSettings();
      const baseInvoke = dashboardInvoke({
        settings,
        workerStatus: { state: "stopped", started_at: null, last_error: null },
      });
      let overviewRequests = 0;
      tauriMocks.invoke.mockImplementation((command, args) => {
        if (command === "get_overview" && overviewRequests++ === 1) {
          return Promise.reject(new Error("transient refresh failure"));
        }
        return baseInvoke(command, args);
      });
      const eventListeners = new Map<string, () => void>();
      tauriMocks.listen.mockImplementation(async (event, listener) => {
        eventListeners.set(event, listener);
        return vi.fn();
      });

      const rendered = render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => {
        eventListeners.get("db_changed")!();
        vi.advanceTimersByTime(300);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(overviewRequests).toBe(2);
      expect(screen.queryByText(/transient refresh failure/)).toBeNull();
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks local development builds distinctly", () => {
    const { container } = render(<App />);

    const devPill = screen.getByText("Dev");
    expect(devPill.classList.contains("brand-dev-pill")).toBe(true);
    expect(devPill.getAttribute("title")).toBe("Local development instance");
    expect(container.querySelector(".dev-environment-banner")).toBeNull();
    expect(
      screen.queryByText("Connected to this checkout, not the installed Symphony app."),
    ).toBeNull();
    expect(screen.queryByText("Local dev")).toBeNull();
  });

  it("does not auto-capitalize repository names", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));

    const repoNameInput = screen.getByLabelText(/^Name/, { selector: "input" });
    expectLiteralInput(repoNameInput);
  });

  it("lets the repository default be cleared or moved", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = {
      ...testSettings(),
      repos: [
        testSettings().repos[0],
        {
          ...testSettings().repos[0],
          name: "backend",
          url: "git@github.com:acme/backend.git",
          team_prefixes: [],
          is_default: false,
        },
      ],
    };
    tauriMocks.invoke.mockImplementation(
      settingsInvoke({
        settings,
        validation: { workflow_ok: true, workflow_blocking: false, workflow_error: null },
      }),
    );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const defaultToggles = (await screen.findAllByLabelText("Default", {
      selector: "input",
    })) as HTMLInputElement[];

    expect(defaultToggles).toHaveLength(2);
    expect(defaultToggles[0].checked).toBe(true);
    expect(defaultToggles[1].checked).toBe(false);

    fireEvent.click(defaultToggles[0]);
    expect(defaultToggles[0].checked).toBe(false);
    expect(defaultToggles[1].checked).toBe(false);

    fireEvent.click(defaultToggles[1]);
    expect(defaultToggles[0].checked).toBe(false);
    expect(defaultToggles[1].checked).toBe(true);
  });

  it("starts with all repositories collapsed and expands only the repository being edited", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = {
      ...testSettings(),
      repos: [
        testSettings().repos[0],
        {
          ...testSettings().repos[0],
          name: "backend",
          url: "git@github.com:acme/backend.git",
          team_prefixes: ["API"],
          is_default: false,
        },
      ],
    };
    tauriMocks.invoke.mockImplementation(dashboardInvoke({ settings }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    const widgetsToggle = await screen.findByRole("button", {
      name: "Edit widgets repository",
    });
    expect(widgetsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByDisplayValue("git@github.com:acme/widgets.git")).toBeNull();
    expect(screen.queryByDisplayValue("git@github.com:acme/backend.git")).toBeNull();

    const backendToggle = await screen.findByRole("button", {
      name: "Edit backend repository",
    });
    expect(backendToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(backendToggle);

    expect(await screen.findByDisplayValue("git@github.com:acme/backend.git")).toBeTruthy();
    expect(screen.queryByDisplayValue("git@github.com:acme/widgets.git")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit widgets repository" }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");

    const repoName = screen.getByLabelText(/^Name/, { selector: "input" });
    fireEvent.change(repoName, { target: { value: "api" } });

    expect(
      screen.getByRole("button", { name: "Collapse api repository" }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Collapse api repository" }));
    expect(
      screen.getByRole("button", { name: "Edit api repository" }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");
    expect(screen.queryByDisplayValue("git@github.com:acme/backend.git")).toBeNull();
  });

  it("uses literal input behavior for settings config fields", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));

    const fields = [
      screen.getByLabelText(/^Repo URL/, { selector: "input" }),
      screen.getByLabelText(/^Install command/, { selector: "input" }),
      screen.getByLabelText(/^Linear teams/, { selector: "input" }),
      screen.getByLabelText(/^Linear projects/, { selector: "input" }),
      screen.getByLabelText(/^Workspace root/, { selector: "input" }),
      screen.getByLabelText(/^API key/, { selector: "input" }),
      screen.getByPlaceholderText("acme"),
      screen.getByLabelText(/^Project/, { selector: "input" }),
      screen.getByLabelText(/^Team prefix/, { selector: "input" }),
      screen.getByLabelText(/^Active states/, { selector: "input" }),
      screen.getByLabelText(/^Terminal states/, { selector: "input" }),
      screen.getByLabelText(/^Session environment/, { selector: "textarea" }),
    ];

    fireEvent.click(screen.getByText("Hooks (advanced)"));
    fields.push(
      screen.getByLabelText(/^After create/, { selector: "textarea" }),
      screen.getByLabelText(/^Before run/, { selector: "textarea" }),
      screen.getByLabelText(/^After run/, { selector: "textarea" }),
      screen.getByLabelText(/^Before remove/, { selector: "textarea" }),
    );

    for (const field of fields) {
      expectLiteralInput(field);
    }
  });

  it("lets settings number fields be cleared before replacement", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = {
      ...testSettings(),
      polling_interval_ms: 60_000,
      max_concurrent_agents: 3,
      max_retry_backoff_ms: 300_000,
      hook_timeout_ms: 30_000,
      turn_timeout_ms: 3_600_000,
      linear_api_key_set: true,
    };
    tauriMocks.invoke.mockImplementation(dashboardInvoke({ settings }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    const edits = [
      [/^Turn timeout/, "120"],
      [/^Polling interval/, "5"],
      [/^Max concurrent agents/, "1"],
      [/^Max retry backoff/, "12.5"],
      [/^Hook timeout/, "45"],
    ] as const;

    for (const [label, nextValue] of edits) {
      const input = (await screen.findByLabelText(label, {
        selector: "input",
      })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "" } });
      expect(input.value).toBe("");
      fireEvent.change(input, { target: { value: nextValue } });
      expect(input.value).toBe(nextValue);
    }

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    const saveCall = () =>
      tauriMocks.invoke.mock.calls.find(([command]) => command === "save_settings");
    await waitFor(() => expect(saveCall()).toBeTruthy());
    expect(saveCall()?.[1].request.settings).toMatchObject({
      turn_timeout_ms: 120_000,
      polling_interval_ms: 5_000,
      max_concurrent_agents: 1,
      max_retry_backoff_ms: 12_500,
      hook_timeout_ms: 45_000,
    });
  });

  it("commits empty settings number fields to zero on blur", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = {
      ...testSettings(),
      polling_interval_ms: 60_000,
      max_concurrent_agents: 3,
      max_retry_backoff_ms: 300_000,
      hook_timeout_ms: 30_000,
      turn_timeout_ms: 3_600_000,
      linear_api_key_set: true,
    };
    tauriMocks.invoke.mockImplementation(dashboardInvoke({ settings }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    for (const label of [
      /^Turn timeout/,
      /^Polling interval/,
      /^Max concurrent agents/,
      /^Max retry backoff/,
      /^Hook timeout/,
    ]) {
      const input = (await screen.findByLabelText(label, {
        selector: "input",
      })) as HTMLInputElement;
      expect(input.required).toBe(true);
      fireEvent.change(input, { target: { value: "" } });
      expect(input.value).toBe("");
      fireEvent.blur(input);
      await waitFor(() => expect(input.value).toBe("0"));
    }

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    const saveCall = () =>
      tauriMocks.invoke.mock.calls.find(([command]) => command === "save_settings");
    await waitFor(() => expect(saveCall()).toBeTruthy());
    expect(saveCall()?.[1].request.settings).toMatchObject({
      turn_timeout_ms: 0,
      polling_interval_ms: 0,
      max_concurrent_agents: 0,
      max_retry_backoff_ms: 0,
      hook_timeout_ms: 0,
    });
  });

  it("shows the Linear user next to the assigned-to-me setting", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true };
    tauriMocks.invoke.mockImplementation(dashboardInvoke({ settings }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    const checkbox = await screen.findByRole("checkbox", {
      name: /Only pick issues assigned to me/,
    });
    fireEvent.click(checkbox);

    const expectedSettings = { ...settings, tracker_assigned_to_me: true };
    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("get_linear_viewer", {
        request: {
          settings: expectedSettings,
          linear_api_key: null,
        },
      }),
    );
    expect(await screen.findByText("alice")).toBeTruthy();
  });

  it("keeps launch commands as literal shell text", async () => {
    tauriMocks.runtimeAvailable = true;
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({ settings: { ...testSettings(), agent_backend: "claude" } }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    const launchCommand = await screen.findByLabelText(/^Launch command/, { selector: "input" });
    expectLiteralInput(launchCommand);
    expectLiteralInput(screen.getByLabelText(/^Allowed tools/, { selector: "textarea" }));
    expectLiteralInput(screen.getByLabelText(/^Disallowed tools/, { selector: "textarea" }));
    expectLiteralInput(screen.getByLabelText(/^Additional directories/, { selector: "textarea" }));

    fireEvent.change(launchCommand, { target: { value: "mycode --agent claude" } });

    expect((launchCommand as HTMLInputElement).value).toBe("mycode --agent claude");
  });

  it("uses literal input behavior for Cursor model names", async () => {
    tauriMocks.runtimeAvailable = true;
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({ settings: { ...testSettings(), agent_backend: "cursor" } }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    expectLiteralInput(await screen.findByLabelText(/^Model/, { selector: "input" }));
  });

  it("shows the mycode launch wrapper in the launch command helper", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const example = screen.getByText("mycode --agent codex");
    expect(example.tagName.toLowerCase()).toBe("code");
    expect(example.getAttribute("class")).toBe("command-example");
  });

  it("keeps the settings save action in the app header", () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const topbar = container.querySelector(".topbar");
    const pageHeader = container.querySelector(".page-header");
    const settingsForm = container.querySelector(".settings-form");
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(topbar?.textContent).toContain("Save");
    expect(topbar?.textContent).not.toContain("Validate");
    expect(topbar?.textContent).not.toContain("Settings valid");
    expect(pageHeader?.textContent).not.toContain("Validate");
    expect(pageHeader?.textContent).not.toContain("Save");
    expect(settingsForm?.id).toBe("settings-form");
    expect(saveButton.getAttribute("type")).toBe("submit");
    expect(saveButton.getAttribute("form")).toBe("settings-form");
  });

  it("explains how saved settings apply while the worker is running", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true };
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        overview: {
          active_runs: [runRow()],
          retry_queue: [],
          recent_failures: [],
          live_sessions: [],
          worker_heartbeat: null,
          rate_limits: [],
          token_usage: [],
        },
      }),
    );

    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(
      await screen.findByText(/Saved settings apply to future dispatches without restarting/),
    ).toBeTruthy();
    expect(screen.getByText(/1 active run keeps the config it started with/)).toBeTruthy();
    expect(screen.getByText(/Applies to hooks that start after Save/)).toBeTruthy();

    const hookTimeout = await screen.findByLabelText(/^Hook timeout/, {
      selector: "input",
    });
    fireEvent.change(hookTimeout, { target: { value: "45" } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(container.querySelector(".topbar")?.textContent).toContain(
        "Saved; future runs use changes",
      ),
    );
  });

  it("does not promise live settings after a worker reconfigure error", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true };
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        overview: {
          active_runs: [runRow()],
          retry_queue: [],
          recent_failures: [],
          live_sessions: [],
          worker_heartbeat: null,
          rate_limits: [],
          token_usage: [],
        },
        workerStatus: {
          state: "running",
          started_at: "2026-01-01T00:00:00.000Z",
          last_error: "tracker configuration rejected",
        },
      }),
    );

    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByText(/Settings save to disk/)).toBeTruthy();
    expect(
      screen.queryByText(/Saved settings apply to future dispatches without restarting/),
    ).toBeNull();

    const hookTimeout = await screen.findByLabelText(/^Hook timeout/, {
      selector: "input",
    });
    fireEvent.change(hookTimeout, { target: { value: "45" } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(container.querySelector(".topbar")?.textContent).toContain(
        "Saved; worker kept previous config",
      ),
    );
    expect(container.querySelector(".topbar")?.textContent).not.toContain(
      "Saved; future runs use changes",
    );
  });

  it("does not promise live settings when save skips reconfigure", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true, repos: [] };
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        validation: {
          workflow_ok: false,
          workflow_blocking: false,
          workflow_error: "No repository configured.",
        },
        overview: {
          active_runs: [runRow()],
          retry_queue: [],
          recent_failures: [],
          live_sessions: [],
          worker_heartbeat: null,
          rate_limits: [],
          token_usage: [],
        },
        workerStatus: {
          state: "running",
          started_at: "2026-01-01T00:00:00.000Z",
          last_error: null,
        },
      }),
    );

    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByText(/this configuration is incomplete/)).toBeTruthy();
    expect(
      screen.queryByText(/Saved settings apply to future dispatches without restarting/),
    ).toBeNull();

    const hookTimeout = await screen.findByLabelText(/^Hook timeout/, {
      selector: "input",
    });
    fireEvent.change(hookTimeout, { target: { value: "45" } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(container.querySelector(".topbar")?.textContent).toContain(
        "Saved; worker kept previous config",
      ),
    );
    expect(container.querySelector(".topbar")?.textContent).not.toContain(
      "Saved; future runs use changes",
    );
  });

  it("shows actionable agent skills install guidance in preview settings", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));

    expect(screen.getByText("Repository does not ship all agent skills.")).toBeTruthy();
    expect(screen.getByText("7 of 7 bundled skills are missing.")).toBeTruthy();
    const createPrButton = screen.getByRole("button", { name: "Create install PR" });
    expect(createPrButton.getAttribute("disabled")).not.toBeNull();
  });

  it("shows the repository workflow source and gates transfer on saved settings", async () => {
    tauriMocks.runtimeAvailable = true;
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings: testSettings(),
        workflowStatus: {
          source: "default",
          filename: null,
          fallback_reason: "missing",
          detail: "No repository workflow was found on the default branch.",
          pr_url: null,
          can_transfer: true,
        },
      }),
    );
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));
    expect(await screen.findByText("Using the saved default workflow.")).toBeTruthy();
    const transfer = screen.getByRole("button", { name: "Transfer workflow to repo" });
    await waitFor(() => expect(transfer.getAttribute("disabled")).toBeNull());

    const editor = container.querySelector<HTMLTextAreaElement>(".prompt-editor textarea");
    expect(editor).toBeTruthy();
    fireEvent.change(editor!, { target: { value: "Unsaved workflow" } });
    expect(transfer.getAttribute("disabled")).not.toBeNull();
    expect(
      screen.getByText("Save Settings before transferring the workflow currently used by the worker."),
    ).toBeTruthy();
  });

  it("shows the exact checked-in workflow filename", async () => {
    tauriMocks.runtimeAvailable = true;
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings: testSettings(),
        workflowStatus: {
          source: "repository",
          filename: "symphony-workflow.md",
          fallback_reason: null,
          detail: null,
          pr_url: null,
          can_transfer: false,
        },
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));
    expect(await screen.findByText("Using symphony-workflow.md.")).toBeTruthy();
    expect(screen.queryByText("Workflow: repository")).toBeNull();
  });

  it("lets users mark repo skills as installed without installing the bundled set", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = {
      ...testSettings(),
      session_env: { GH_TOKEN: "from-settings" },
    };
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        skillsStatus: {
          state: "missing",
          missing: ["symphony-workpad", "symphony-commit"],
          pr_url: null,
          detail: null,
        },
      }),
    );

    render(<App />);

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("get_skills_status", {
        repoUrl: settings.repos[0].url.trim(),
        sessionEnv: settings.session_env,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));

    expect(
      await screen.findByText("Repository does not ship all agent skills."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark installed" }));

    expect(screen.getByText("Agent skills are marked installed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use automatic check" })).toBeTruthy();

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    const saveCall = () =>
      tauriMocks.invoke.mock.calls.find(([command]) => command === "save_settings");
    await waitFor(() => expect(saveCall()).toBeTruthy());
    expect(
      saveCall()?.[1].request.settings.repos[0].skills_marked_installed,
    ).toBe(true);
  });

  it("rechecks repo skills when the session environment changes", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = testSettings();
    tauriMocks.invoke.mockImplementation(dashboardInvoke({ settings }));

    render(<App />);

    const repoUrl = settings.repos[0].url.trim();
    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("get_skills_status", {
        repoUrl,
        sessionEnv: {},
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(
      screen.getByLabelText(/^Session environment/, { selector: "textarea" }),
      { target: { value: "GITHUB_TOKEN=from-session" } },
    );

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("get_skills_status", {
        repoUrl,
        sessionEnv: { GITHUB_TOKEN: "from-session" },
      }),
    );
  });

  it("links missing agent CLIs to their official installation guide", async () => {
    tauriMocks.runtimeAvailable = true;
    tauriMocks.openUrl.mockResolvedValue(undefined);
    const settings = testSettings();
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        validation: {
          workflow_ok: true,
          workflow_blocking: false,
          workflow_error: null,
          cursor_found: false,
        },
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(await screen.findByText("Codex CLI")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install Cursor" })).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Backend" }));
    fireEvent.click(screen.getByRole("option", { name: "Cursor" }));

    const installButton = await screen.findByRole("button", { name: "Install Cursor" });
    expect(
      screen.getByText(
        "After installing, open Cursor CLI once to sign in and choose a default model.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/The CLI that works on issues/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/^Launch command/, { selector: "input" }), {
      target: { value: "custom-cursor" },
    });
    expect(await screen.findByText("custom-cursor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install Cursor" })).toBeTruthy();

    fireEvent.click(installButton);

    expect(tauriMocks.openUrl).toHaveBeenCalledWith(
      "https://cursor.com/docs/cli/installation",
    );
    expect(screen.queryByRole("button", { name: "Install Codex" })).toBeNull();
    expect(screen.queryByText("Claude Code CLI")).toBeNull();
  });

  it("clears the manual skills mark when the repository URL changes", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = testSettings();
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        skillsStatus: {
          state: "missing",
          missing: ["symphony-workpad"],
          pr_url: null,
          detail: null,
        },
      }),
    );

    render(<App />);

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("get_skills_status", {
        repoUrl: settings.repos[0].url.trim(),
        sessionEnv: settings.session_env,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark installed" }));
    expect(screen.getByText("Agent skills are marked installed.")).toBeTruthy();

    const repoUrl = screen.getByLabelText(/^Repo URL/, {
      selector: "input",
    }) as HTMLInputElement;
    fireEvent.change(repoUrl, { target: { value: "git@github.com:acme/api.git" } });

    expect(screen.queryByText("Agent skills are marked installed.")).toBeNull();

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    const saveCall = () =>
      tauriMocks.invoke.mock.calls.find(([command]) => command === "save_settings");
    await waitFor(() => expect(saveCall()).toBeTruthy());
    expect(saveCall()?.[1].request.settings.repos[0]).toMatchObject({
      url: "git@github.com:acme/api.git",
      skills_marked_installed: false,
    });
  });

  it("shows PR links as standard view actions when an install PR is open", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = testSettings();
    const prUrl = "https://github.com/acme/widgets/pull/61";
    tauriMocks.openUrl.mockResolvedValue(undefined);
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        skillsStatus: {
          state: "missing",
          missing: ["symphony-workpad"],
          pr_url: prUrl,
          detail: null,
        },
      }),
    );

    render(<App />);

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("get_skills_status", {
        repoUrl: settings.repos[0].url.trim(),
        sessionEnv: settings.session_env,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));

    expect(await screen.findByText("An install PR is waiting for review.")).toBeTruthy();
    const viewPrButton = screen.getByRole("button", { name: "View PR" });
    const checkAgainButtons = screen.getAllByRole("button", { name: "Check again" });
    const checkAgainButton = checkAgainButtons[checkAgainButtons.length - 1];
    expect(screen.queryByRole("button", { name: "Open PR" })).toBeNull();
    expect(viewPrButton.className).toBe(checkAgainButton.className);

    fireEvent.click(viewPrButton);

    expect(tauriMocks.openUrl).toHaveBeenCalledWith(prUrl);
  });

  it("shows a dependency graph for watched issue blockers", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true };
    const issues = [
      issueRow({
        id: "issue-sym-10",
        identifier: "SYM-10",
        title: "Create deploy queue",
        state: "Todo",
      }),
      issueRow({
        id: "issue-sym-11",
        identifier: "SYM-11",
        title: "Build deploy dashboard",
        state: "In Progress",
        blockers: ["SYM-10", "OPS-1"],
      }),
    ];
    tauriMocks.invoke.mockImplementation(dashboardInvoke({ settings, issues }));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Issues" }));
    expect(await screen.findByText("Build deploy dashboard")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Dependencies" }));

    expect(
      screen.getByRole("group", { name: /Dependency graph with 3 nodes and 2 blocking links/ }),
    ).toBeTruthy();
    expect(screen.getByText("Blocked issues")).toBeTruthy();
    expect(screen.getByLabelText("OPS-1, external blocker")).toBeTruthy();
    expect(screen.getByText("Outside current issue filters")).toBeTruthy();
    expect(screen.getByLabelText("SYM-10 blocks SYM-11")).toBeTruthy();
    expect(screen.getByLabelText("OPS-1 blocks SYM-11")).toBeTruthy();
  });

  it("validates before saving and shows validation errors in the header status", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = testSettings();
    const validationError = "Active states is empty — add at least one Linear state.";
    tauriMocks.invoke.mockImplementation(
      settingsInvoke({
        settings,
        validation: {
          workflow_ok: false,
          workflow_blocking: true,
          workflow_error: validationError,
        },
      }),
    );

    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const apiKey = await screen.findByLabelText(/^API key/, { selector: "input" });
    fireEvent.change(apiKey, { target: { value: "lin_api_test" } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    await waitFor(() => expect(screen.getByText(validationError)).toBeTruthy());
    expect(tauriMocks.invoke).toHaveBeenCalledWith("validate_settings", { settings });
    expect(
      tauriMocks.invoke.mock.calls.some(([command]) => command === "save_settings"),
    ).toBe(false);
    const topbar = container.querySelector(".topbar");
    expect(topbar?.textContent).toContain(validationError);
    expect(topbar?.textContent).not.toContain("Settings valid");
  });

  it("saves an incomplete setup without flagging it as a blocking error", async () => {
    tauriMocks.runtimeAvailable = true;
    // A first-time user with no repo configured yet, entering only a Linear key.
    const settings = { ...testSettings(), repos: [], linear_api_key_set: false };
    const incompleteError = "No repository configured — add one under Settings → Repositories.";
    tauriMocks.invoke.mockImplementation(
      settingsInvoke({
        settings,
        // Missing repo is an unfinished setup, not a blocking mistake.
        validation: {
          workflow_ok: false,
          workflow_blocking: false,
          workflow_error: incompleteError,
        },
        allowSave: true,
      }),
    );

    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const apiKey = await screen.findByLabelText(/^API key/, { selector: "input" });
    fireEvent.change(apiKey, { target: { value: "lin_api_test" } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton.getAttribute("disabled")).toBeNull());
    fireEvent.click(saveButton);

    // The partial setup is persisted: save runs and carries the typed key.
    const saveCall = () =>
      tauriMocks.invoke.mock.calls.find(([command]) => command === "save_settings");
    await waitFor(() => expect(saveCall()).toBeTruthy());
    expect(saveCall()?.[1]).toEqual({
      request: { settings, linear_api_key: "lin_api_test" },
    });
    // A non-blocking incompleteness message is not shown as a header error.
    const topbar = container.querySelector(".topbar");
    expect(topbar?.textContent).not.toContain(incompleteError);
  });

  it("shows overview onboarding only for the first two setup requirements", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), repos: [], linear_api_key_set: false };
    tauriMocks.invoke.mockImplementation(dashboardInvoke({ settings }));

    render(<App />);

    expect(await screen.findByText("Welcome to Symphony")).toBeTruthy();
    expect(screen.getByText("Connect Linear")).toBeTruthy();
    expect(screen.getByText("Add your repositories")).toBeTruthy();
    expect(screen.queryByText("Install agent skills")).toBeNull();
    expect(screen.queryByText("Start the worker")).toBeNull();
  });

  it("dismisses overview onboarding after Linear and repo setup even when skills are missing", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true };
    const repoUrl = settings.repos[0].url;
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        skillsStatus: {
          state: "missing",
          missing: ["symphony-workpad"],
          pr_url: null,
          detail: null,
        },
      }),
    );

    render(<App />);

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("get_skills_status", {
        repoUrl,
        sessionEnv: settings.session_env,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit widgets repository" }));
    expect(
      await screen.findByText("Repository does not ship all agent skills."),
    ).toBeTruthy();
    expect(screen.getByText("1 of 7 bundled skills are missing.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));

    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.queryByText("Welcome to Symphony")).toBeNull();
    expect(screen.queryByText("Install agent skills")).toBeNull();
  });

  it("lets the user trigger a queued retry immediately", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true };
    tauriMocks.invoke.mockImplementation(
      dashboardInvoke({
        settings,
        overview: {
          active_runs: [],
          retry_queue: [
            {
              issue_id: "lin-retry-1",
              run_number: 3,
              due_at: "2099-01-01T00:00:00.000Z",
              error_class: "agent_failure",
              error_message: "failed",
              created_at: "2026-01-01T00:00:00.000Z",
              issue_identifier: "SYM-99",
              issue_title: "Retry from the dashboard",
            },
          ],
          recent_failures: [],
          live_sessions: [],
          worker_heartbeat: null,
          rate_limits: [],
          token_usage: [],
        },
        workerStatus: {
          state: "running",
          started_at: "2026-01-01T00:00:00.000Z",
          last_error: null,
        },
      }),
    );

    render(<App />);

    const retryButton = await screen.findByRole("button", { name: "Retry now" });
    fireEvent.click(retryButton);

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("trigger_retry_now", {
        issueId: "lin-retry-1",
      }),
    );
  });

  it("lets the user retry a cancelled run from the run detail view", async () => {
    tauriMocks.runtimeAvailable = true;
    const settings = { ...testSettings(), linear_api_key_set: true };
    const cancelledRun = runRow({
      id: "run-cancelled-1",
      issue_id: "lin-cancelled-1",
      run_number: 2,
      status: "cancelled",
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:10:00.000Z",
      error_class: "cancelled",
      error_message: "run cancelled",
      worker_pid: null,
      created_at: "2026-01-01T00:00:00.000Z",
      issue_identifier: "SYM-100",
      issue_title: "Retry the cancelled run",
      issue_state: "Todo",
    });
    const baseInvoke = dashboardInvoke({
      settings,
      overview: {
        active_runs: [],
        retry_queue: [],
        recent_failures: [],
        live_sessions: [],
        worker_heartbeat: null,
        rate_limits: [],
        token_usage: [],
      },
      workerStatus: {
        state: "running",
        started_at: "2026-01-01T00:00:00.000Z",
        last_error: null,
      },
    });
    tauriMocks.invoke.mockImplementation(async (command, args) => {
      if (command === "list_runs") {
        return [cancelledRun];
      }
      if (command === "get_run_detail" && args?.id === cancelledRun.id) {
        return { run: cancelledRun, events: [] };
      }
      return baseInvoke(command, args);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open run SYM-100 number 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry run" }));

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("trigger_retry_now", {
        issueId: "lin-cancelled-1",
      }),
    );
  });
});
