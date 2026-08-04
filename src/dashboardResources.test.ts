import { describe, expect, it } from "vitest";
import {
  resourcesForDbChange,
  visibleResources,
  type DashboardResourceKey,
  type DashboardView,
} from "./dashboardResources";

describe("dashboard resource invalidation map", () => {
  it.each([
    ["rate_limit_state", ["overview"]],
    ["token_usage", ["overview"]],
    ["workspace_cleanup_queue", ["overview"]],
    ["worker_heartbeat", []],
    ["issues", ["issues", "overview", "runs", "selectedRun"]],
    ["issue_dispatch_suppressions", ["issues", "overview"]],
    ["retry_queue", ["issues", "overview"]],
    ["runs", ["runs", "overview", "selectedRun"]],
    ["live_sessions", ["runs", "overview", "selectedRun"]],
    ["hook_runs", ["runs", "overview", "selectedRun"]],
    ["agent_events", ["overview", "selectedRun"]],
    ["retros", ["retroList", "selectedRetro"]],
    ["retro_suggestions", ["retroList", "selectedRetro"]],
    ["retro_inputs", ["retroList", "selectedRetro"]],
    ["workpad_snapshots", ["retroList", "selectedRetro"]],
    ["retro_batches", ["retroBatches", "selectedRetro"]],
    ["workflows", ["overview"]],
  ] as const)("maps %s", (table, expected) => {
    expect(resourcesForDbChange(table)).toEqual(expected);
  });

  it("uses the conservative unknown-table fallback without selected detail", () => {
    expect(resourcesForDbChange("future_table")).toEqual([
      "overview",
      "runs",
      "issues",
      "worker",
      "retroList",
      "retroBatches",
    ]);
  });

  it.each([
    ["overview", ["overview", "worker"]],
    ["runs", ["overview", "runs", "worker", "selectedRun"]],
    ["issues", ["overview", "issues", "worker"]],
    ["retro", ["overview", "worker", "retroList", "retroBatches", "selectedRetro"]],
    ["settings", ["overview", "worker"]],
  ] as Array<[DashboardView, DashboardResourceKey[]]>)(
    "fetches only resources visible from %s",
    (view, expected) => {
      expect(
        visibleResources(
          [
            "overview",
            "runs",
            "issues",
            "worker",
            "retroList",
            "retroBatches",
            "selectedRun",
            "selectedRetro",
          ],
          view,
          "run-1",
          "retro-1",
        ),
      ).toEqual(expected);
    },
  );
});
