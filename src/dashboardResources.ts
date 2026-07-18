import type { AgentEventRow } from "./bindings";

export type DashboardResourceKey =
  | "overview"
  | "runs"
  | "issues"
  | "worker"
  | "retroList"
  | "retroBatches"
  | "selectedRun"
  | "selectedRetro";

export type DashboardView = "overview" | "runs" | "issues" | "retro" | "settings";

export type DbChanged = { type: "db_changed"; table: string; op: string };
export type AgentEvent = { type: "agent_event"; event: AgentEventRow };
export type RateLimitChanged = { type: "rate_limit_changed"; source: string };

const TABLE_INVALIDATIONS: Record<string, readonly DashboardResourceKey[]> = {
  rate_limit_state: ["overview"],
  token_usage: ["overview"],
  // The heartbeat row is part of Overview. Refreshing only WorkerStatus here
  // leaves the shell evaluating an old beat forever after the first load.
  worker_heartbeat: ["overview"],
  // Runs and run detail join issue title/state, so issue row updates must also
  // invalidate those caches even when the Issues view remains hidden.
  issues: ["issues", "overview", "runs", "selectedRun"],
  issue_dispatch_suppressions: ["issues", "overview"],
  retry_queue: ["issues", "overview"],
  runs: ["runs", "overview", "selectedRun"],
  live_sessions: ["runs", "overview", "selectedRun"],
  hook_runs: ["runs", "overview", "selectedRun"],
  agent_events: ["overview", "selectedRun"],
  retros: ["retroList", "selectedRetro"],
  retro_suggestions: ["retroList", "selectedRetro"],
  retro_inputs: ["retroList", "selectedRetro"],
  workpad_snapshots: ["retroList", "selectedRetro"],
  retro_batches: ["retroBatches", "selectedRetro"],
  workflows: ["overview"],
};

const UNKNOWN_TABLE_FALLBACK: readonly DashboardResourceKey[] = [
  "overview",
  "runs",
  "issues",
  "worker",
  "retroList",
  "retroBatches",
];

export function resourcesForDbChange(table: string): readonly DashboardResourceKey[] {
  return TABLE_INVALIDATIONS[table] ?? UNKNOWN_TABLE_FALLBACK;
}

export function visibleResources(
  keys: Iterable<DashboardResourceKey>,
  view: DashboardView,
  selectedRunId: string | null,
  selectedRetroId: string | null,
): DashboardResourceKey[] {
  return [...new Set(keys)].filter((key) => {
    if (key === "overview" || key === "worker") return true;
    if (key === "runs") return view === "runs";
    if (key === "issues") return view === "issues";
    if (key === "retroList" || key === "retroBatches") return view === "retro";
    if (key === "selectedRun") return view === "runs" && selectedRunId !== null;
    return view === "retro" && selectedRetroId !== null;
  });
}

export function resourcesForView(view: DashboardView): DashboardResourceKey[] {
  if (view === "overview") return ["overview"];
  if (view === "runs") return ["runs", "selectedRun"];
  if (view === "issues") return ["issues"];
  if (view === "retro") return ["retroList", "retroBatches", "selectedRetro"];
  return [];
}
