export type DashboardResourceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "refreshing"
  | "stale"
  | "error";

export type DashboardResourceError = {
  summary: string;
  technicalDetails: string | null;
};

export type DashboardResourceEnvelope<T> = {
  data: T | undefined;
  status: DashboardResourceStatus;
  dirtySince: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: DashboardResourceError | null;
};

export type WorkerConnectivity = "healthy" | "stale" | "disconnected" | "stopped";

type WorkerState = "stopped" | "running" | "stopping";

const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const ENV_SECRET_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|COOKIE)[A-Z0-9_]*=)[^\s]+/g;
const BEARER_TOKEN = /(bearer\s+)[a-z0-9._~+/=-]+/gi;
const SETTINGS_OBJECT = /("?(?:session_env|settings)"?\s*:\s*)\{[^}]*\}/gi;
const SETTINGS_MARKER =
  /(?:prompt_template|workspace_root|session_env|linear_api_key|codex_command|claude_command|cursor_command|opencode_command)/i;
const MAX_TECHNICAL_DETAILS = 800;

export function createResourceEnvelope<T>(
  data?: T,
  now: string | null = data === undefined ? null : new Date().toISOString(),
): DashboardResourceEnvelope<T> {
  return {
    data,
    status: data === undefined ? "idle" : "ready",
    dirtySince: null,
    lastAttemptAt: now,
    lastSuccessAt: now,
    error: null,
  };
}

export function markResourceDirty<T>(
  resource: DashboardResourceEnvelope<T>,
  now: string,
): DashboardResourceEnvelope<T> {
  return resource.dirtySince
    ? resource
    : { ...resource, dirtySince: now };
}

export function beginResourceRefresh<T>(
  resource: DashboardResourceEnvelope<T>,
  now: string,
): DashboardResourceEnvelope<T> {
  return {
    ...resource,
    status: resource.data === undefined ? "loading" : "refreshing",
    lastAttemptAt: now,
    // Keep the prior failure until an authoritative success recovers it.
    error: resource.error,
  };
}

export function completeResourceRefresh<T>(
  resource: DashboardResourceEnvelope<T>,
  data: T,
  now: string,
): DashboardResourceEnvelope<T> {
  return {
    ...resource,
    data,
    status: "ready",
    dirtySince: null,
    lastAttemptAt:
      resource.status === "loading" || resource.status === "refreshing"
        ? resource.lastAttemptAt
        : now,
    lastSuccessAt: now,
    error: null,
  };
}

export function failResourceRefresh<T>(
  resource: DashboardResourceEnvelope<T>,
  error: DashboardResourceError,
  now: string,
): DashboardResourceEnvelope<T> {
  return {
    ...resource,
    status: resource.data === undefined ? "error" : "stale",
    lastAttemptAt: resource.lastAttemptAt ?? now,
    error,
  };
}

export function staleDirtyResource<T>(
  resource: DashboardResourceEnvelope<T>,
  nowMs: number,
  visible: boolean,
): DashboardResourceEnvelope<T> {
  if (
    !visible ||
    resource.data === undefined ||
    resource.dirtySince === null ||
    resource.status === "stale" ||
    resource.status === "error"
  ) {
    return resource;
  }
  const dirtyAt = Date.parse(resource.dirtySince);
  if (!Number.isFinite(dirtyAt) || nowMs - dirtyAt < 60_000) return resource;
  return { ...resource, status: "stale" };
}

export function hasResourceData<T>(resource: DashboardResourceEnvelope<T>) {
  return resource.data !== undefined;
}

export function resourceIsStale<T>(resource: DashboardResourceEnvelope<T>) {
  return (
    resource.status === "stale" ||
    (resource.status === "refreshing" && resource.error !== null)
  );
}

export function sanitizeTechnicalDetails(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (SETTINGS_MARKER.test(raw)) return "Configuration details redacted.";
  const sanitized = raw
    .replace(BEARER_TOKEN, "$1[redacted]")
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(ENV_SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(SETTINGS_OBJECT, "$1{[redacted]}")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TECHNICAL_DETAILS);
  return sanitized === "" ? null : sanitized;
}

export function normalizeResourceError(
  resourceLabel: string,
  error: unknown,
): DashboardResourceError {
  return {
    summary: `${resourceLabel} could not be refreshed.`,
    technicalDetails: sanitizeTechnicalDetails(error),
  };
}

export function workerConnectivity(
  state: WorkerState,
  lastBeatAt: string | null,
  nowMs: number,
): WorkerConnectivity {
  if (state === "stopped") return "stopped";
  const beatMs = lastBeatAt === null ? Number.NaN : Date.parse(lastBeatAt);
  if (!Number.isFinite(beatMs)) {
    return state === "running" ? "disconnected" : "stale";
  }
  const ageMs = Math.max(0, nowMs - beatMs);
  if (ageMs <= 6_000) return "healthy";
  if (ageMs <= 30_000 || state === "stopping") return "stale";
  return "disconnected";
}
