import type { AppSettings, RetroBatchRow } from "./bindings";

export function reconcileSettingsDraft(
  saved: AppSettings,
  draft: AppSettings,
  dirty: boolean,
) {
  return dirty ? draft : saved;
}

export function retroRepoBatchState(
  batches: RetroBatchRow[],
  repoName: string,
): "available" | "locked" | "stale" {
  const repoBatches = batches.filter(
    (batch) => batch.kind === "repo_pr" && batch.repo_name === repoName,
  );
  if (
    repoBatches.some((batch) =>
      ["queued", "running", "completed"].includes(batch.state),
    )
  ) {
    return "locked";
  }
  if (repoBatches.some((batch) => batch.state === "stale")) return "stale";
  return "available";
}
