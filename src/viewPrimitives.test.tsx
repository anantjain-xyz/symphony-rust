// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, RunWithIssueRow } from "./bindings";
import { Badge, Empty, formSnapshot, Panel, RunTable } from "./viewPrimitives";

function run(): RunWithIssueRow {
  return {
    id: "run-1",
    issue_id: "issue-1",
    run_number: 3,
    workspace_path: "/tmp/run-1",
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    error_class: "Timeout",
    error_message: "agent stopped responding",
    worker_pid: 42,
    session_info: null,
    repo_name: "symphony",
    created_at: "2026-01-01T00:00:00.000Z",
    issue_identifier: "OP-1",
    issue_title: "Consolidate the table",
    issue_state: "Todo",
  };
}

afterEach(cleanup);

describe("shared view primitives", () => {
  it("preserves the run table row semantics and keyboard activation", () => {
    const onOpenRun = vi.fn();
    render(
      <RunTable
        runs={[run()]}
        onOpenRun={onOpenRun}
        activeRunIds={new Set(["run-1"])}
        selectedRunId="run-1"
        lastActivity={new Map([["run-1", "2026-01-01T00:01:00.000Z"]])}
        showRepo
      />,
    );

    const row = screen.getByRole("button", { name: "Open run OP-1 number 3" });
    expect(row.className).toBe("clickable-row selected");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("symphony").className).toBe("repo-badge");
    expect(screen.getByText("Timeout: agent stopped responding").className).toBe("row-error");
    expect(screen.getByText("running").className).toContain("badge running");

    fireEvent.keyDown(row, { key: " " });
    expect(onOpenRun).toHaveBeenCalledWith("run-1");
  });

  it("shares panel, empty-state action, and badge markup", () => {
    const onAction = vi.fn();
    render(
      <Panel title="Run history">
        <Empty
          title="No runs"
          text="Runs will appear here."
          actionLabel="Open settings"
          onAction={onAction}
        />
      </Panel>,
    );
    render(<Badge status="In Progress" />);

    expect(screen.getByRole("heading", { name: "Run history" }).closest("section")?.className).toBe(
      "panel",
    );
    expect(screen.getByText("Runs will appear here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("In Progress").className).toBe("badge in-progress");
  });

  it("omits the server-derived API-key flag from form snapshots", () => {
    const settings = {
      prompt_template: "Prompt",
      repos: [],
      linear_api_key_set: false,
    } as unknown as AppSettings;
    const saved = formSnapshot(settings);
    const withKey = formSnapshot({ ...settings, linear_api_key_set: true });

    expect(saved).toBe(withKey);
    expect(saved).not.toContain("linear_api_key_set");
  });
});
