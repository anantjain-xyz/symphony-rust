import type {
  AgentEvent,
  DashboardOverview,
  RetroDetail,
  RunDetail,
  RunSummary,
  SuggestionDecision,
} from "../bindings";
export function cancelRun(
  id: string,
  snapshot: { runs: RunSummary[]; overview: DashboardOverview; selectedRun: RunDetail | null },
) {
  const endedAt = new Date().toISOString();
  const cancelRun = (run: RunSummary): RunSummary =>
    run.id === id
      ? {
          ...run,
          status: "cancelled",
          ended_at: endedAt,
          error_class: "cancelled",
          error_message: "run cancelled",
        }
      : run;
  const event: AgentEvent = {
    id: Date.now(),
    run_id: id,
    kind: "status",
    payload: { message: "Run cancellation requested" },
    created_at: endedAt,
  };
  const runs = snapshot.runs.map(cancelRun);
  const overview = {
    ...snapshot.overview,
    active_runs: snapshot.overview.active_runs.filter((run) => run.id !== id),
    live_sessions: snapshot.overview.live_sessions.filter((session) => session.run_id !== id),
  };
  const selectedRun =
    snapshot.selectedRun?.run.id === id
      ? {
          run: cancelRun(snapshot.selectedRun.run),
          events: [...snapshot.selectedRun.events, event],
        }
      : snapshot.selectedRun;
  return { runs, overview, selectedRun };
}
export function decideSuggestion(
  current: RetroDetail | null,
  id: string,
  decision: SuggestionDecision,
): RetroDetail | null {
  return current
    ? {
        ...current,
        suggestions: current.suggestions.map((suggestion) =>
          suggestion.id === id
            ? {
                ...suggestion,
                decision,
                decided_at: decision === "pending" ? null : new Date().toISOString(),
              }
            : suggestion,
        ),
      }
    : current;
}
