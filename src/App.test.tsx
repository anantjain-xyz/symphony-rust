// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { AppSettings, ValidationResult } from "./bindings";

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
    linear_api_key_set: false,
  };
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
          codex_command: "codex",
          claude_command: "claude",
          app_data_dir: "/tmp/symphony",
          database_path: "/tmp/symphony/symphony.db",
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
  });

  it("does not auto-capitalize repository names", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const repoNameInput = screen.getByLabelText(/^Name/, { selector: "input" });
    expect(repoNameInput.getAttribute("autocapitalize")).toBe("none");
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
});
