// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type {
  AppSettings,
  IssueRow,
  Overview,
  SkillsStatus,
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
    linear_api_key_set: false,
  };
}

function expectLiteralInput(element: Element) {
  expect(element.getAttribute("autocomplete")).toBe("off");
  expect(element.getAttribute("autocorrect")).toBe("off");
  expect(element.getAttribute("autocapitalize")).toBe("none");
  expect(element.getAttribute("spellcheck")).toBe("false");
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
        return [];
      case "get_worker_status":
        return { state: "stopped", started_at: null, last_error: null };
      case "validate_settings":
        return {
          ...validation,
          codex_found: true,
          claude_found: true,
          cursor_found: true,
          codex_command: "codex",
          claude_command: "claude",
          cursor_command: "agent",
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
  workerStatus?: WorkerStatus;
}) {
  return async (command: string) => {
    switch (command) {
      case "load_settings":
        return settings;
      case "get_overview":
        return overview;
      case "list_runs":
        return [];
      case "list_issues":
        return issues;
      case "get_worker_status":
        return workerStatus;
      case "trigger_retry_now":
        return true;
      case "get_skills_status":
        return skillsStatus;
      case "validate_settings":
        return {
          workflow_ok: true,
          workflow_blocking: false,
          workflow_error: null,
          codex_found: true,
          claude_found: true,
          cursor_found: true,
          codex_command: "codex",
          claude_command: "claude",
          cursor_command: "agent",
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

  it("does not auto-capitalize repository names", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const repoNameInput = screen.getByLabelText(/^Name/, { selector: "input" });
    expectLiteralInput(repoNameInput);
  });

  it("uses literal input behavior for settings config fields", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

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

  it("shows actionable agent skills install guidance in preview settings", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("Agent skills are not installed.")).toBeTruthy();
    expect(screen.getByText("7 of 7 bundled skills are missing.")).toBeTruthy();
    const createPrButton = screen.getByRole("button", { name: "Create install PR" });
    expect(createPrButton.getAttribute("disabled")).not.toBeNull();
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
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(await screen.findByText("An install PR is waiting for review.")).toBeTruthy();
    const viewPrButton = screen.getByRole("button", { name: "View PR" });
    const checkAgainButton = screen.getByRole("button", { name: "Check again" });
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
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Agent skills are not installed.")).toBeTruthy();
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
});
