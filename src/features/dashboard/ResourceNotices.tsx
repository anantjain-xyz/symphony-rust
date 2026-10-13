import {
  type DashboardResourceEnvelope,
  type DashboardResourceError,
  hasResourceData,
  resourceIsStale,
} from "../../dashboardResourceState";
import type { DashboardResourceKey } from "../../dashboardResources";
import { RelativeTime } from "../../RelativeTime";
import { type DashboardResourceEnvelopes, RESOURCE_LABELS } from "./useDashboardController";
export function ResourceNotices({
  resources,
  resourceKeys,
  slowRefreshingKeys,
  onRetry,
}: {
  resources: DashboardResourceEnvelopes;
  resourceKeys: DashboardResourceKey[];
  slowRefreshingKeys: Set<DashboardResourceKey>;
  onRetry: (key: DashboardResourceKey) => void;
}) {
  const notices = resourceKeys.flatMap((key) => {
    const resource = resources[key] as DashboardResourceEnvelope<unknown>;
    const hasData = hasResourceData(resource);
    const stale = resourceIsStale(resource);
    const noDataFailure = !hasData && resource.error !== null;
    const refreshing = resource.status === "loading" || resource.status === "refreshing";
    const showRefreshing = slowRefreshingKeys.has(key) && refreshing;
    if (!stale && !noDataFailure && !showRefreshing) return [];
    const error = resource.error as DashboardResourceError | null;

    return [
      <section
        key={key}
        className={`resource-notice ${noDataFailure ? "resource-error" : stale ? "resource-stale" : "resource-refreshing"}`}
        role={noDataFailure ? "alert" : undefined}
        aria-busy={refreshing ? "true" : undefined}
      >
        <div className="resource-notice-copy">
          <div className="resource-notice-title">
            <strong>{RESOURCE_LABELS[key]}</strong>
            {stale ? <span className="resource-stale-badge">Stale</span> : null}
            {showRefreshing ? <span className="resource-refreshing-label">Refreshing…</span> : null}
          </div>
          {noDataFailure ? (
            <span>{error?.summary} No data is available.</span>
          ) : stale ? (
            <span>
              Showing the last successful data
              {resource.lastSuccessAt ? (
                <>
                  {" "}
                  from <RelativeTime value={resource.lastSuccessAt} />
                </>
              ) : null}
              .
            </span>
          ) : (
            <span>Fetching the latest data while current content remains visible.</span>
          )}
          {error?.technicalDetails ? (
            <details>
              <summary>Technical details</summary>
              <code>{error.technicalDetails}</code>
            </details>
          ) : null}
        </div>
        {stale || noDataFailure ? (
          <button
            type="button"
            className="secondary"
            disabled={refreshing}
            aria-label={`Retry ${RESOURCE_LABELS[key]}`}
            onClick={() => onRetry(key)}
          >
            Retry
          </button>
        ) : null}
      </section>,
    ];
  });

  return notices.length > 0 ? notices : null;
}
