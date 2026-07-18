import type { RateLimitStateRow, TokenUsageRow } from "./bindings";

export function shortTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function relativeTime(value: string, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = date.getTime() - now;
  const future = diffMs > 0;
  const abs = Math.abs(diffMs);

  if (abs < 45_000) return future ? "in a moment" : "just now";

  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;

  const hours = Math.round(abs / 3_600_000);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;

  const days = Math.round(abs / 86_400_000);
  if (days < 7) return future ? `in ${days}d` : `${days}d ago`;

  return date.toLocaleDateString();
}

const PROVIDERS = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
  { key: "cursor", label: "Cursor" },
  { key: "opencode", label: "opencode" },
];

export type ProviderRateLimit = {
  id: string;
  label: string;
  limit: RateLimitStateRow | null;
};

// One display row per provider, even without signals; a provider with
// several signal buckets (codex_primary, codex_secondary, ...) gets a row
// per bucket. Sources from unknown providers are appended as-is.
export function providerRateLimits(
  limits: RateLimitStateRow[],
): ProviderRateLimit[] {
  const claimed = new Set<string>();
  const rows = PROVIDERS.flatMap(({ key, label }): ProviderRateLimit[] => {
    const matches = limits.filter(
      (limit) => limit.source === key || limit.source.startsWith(`${key}_`),
    );
    matches.forEach((limit) => claimed.add(limit.source));
    if (matches.length === 0) return [{ id: key, label, limit: null }];
    return matches.map((limit) => ({
      id: limit.source,
      label:
        limit.source === key
          ? label
          : `${label} · ${limit.source.slice(key.length + 1)}`,
      limit,
    }));
  });
  const extras = limits
    .filter((limit) => !claimed.has(limit.source))
    .map((limit) => ({ id: limit.source, label: limit.source, limit }));
  return [...rows, ...extras];
}

export type ProviderTokenUsage = {
  id: string;
  label: string;
  usage: TokenUsageRow | null;
};

// One display row per provider, even before any usage is recorded; sources
// from unknown providers are appended as-is.
export function providerTokenUsage(rows: TokenUsageRow[]): ProviderTokenUsage[] {
  const claimed = new Set<string>();
  const known = PROVIDERS.map(({ key, label }): ProviderTokenUsage => {
    const usage = rows.find((row) => row.source === key) ?? null;
    if (usage) claimed.add(usage.source);
    return { id: key, label, usage };
  });
  const extras = rows
    .filter((row) => !claimed.has(row.source))
    .map((row) => ({ id: row.source, label: row.source, usage: row }));
  return [...known, ...extras];
}

export function formatTokens(count: number) {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

const PRIORITY_LABELS = ["None", "Urgent", "High", "Medium", "Low"];

export function priorityLabel(priority: number) {
  return PRIORITY_LABELS[priority] ?? String(priority);
}

export function statusSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function timeOnly(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

export type SessionInfo = {
  model: string | null;
  permission_mode: string | null;
  agent_version: string | null;
  output_style: string | null;
  fast_mode: string | null;
  thinking_tokens: number | null;
};

export function parseSessionInfo(raw: string | null): SessionInfo | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SessionInfo;
  } catch {
    return null;
  }
}

export type EventSummary = {
  label: string;
  summary: string;
  tone?: "error";
};

export type ParsedEventPayload = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function parseEventPayload(payload: string): ParsedEventPayload | undefined {
  try {
    return JSON.parse(payload) as ParsedEventPayload;
  } catch {
    return undefined;
  }
}

function isGenericToolLifecycle(summary: string) {
  return summary === "running" || /^exit (?:-?\d+|\?)$/.test(summary);
}

function toolCallDetail(resultSummary: string | null, command: string | null) {
  if (!resultSummary) return command ?? "";
  if (!command || resultSummary === command) return resultSummary;
  if (!isGenericToolLifecycle(resultSummary)) return resultSummary;
  return resultSummary === "running" ? command : `${command} (${resultSummary})`;
}

export function describeEvent(
  kind: string,
  payload: string,
  parsed: ParsedEventPayload | undefined = parseEventPayload(payload),
): EventSummary {
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const count = (value: unknown) => (typeof value === "number" ? value : 0);

  switch (kind) {
    case "status":
      return { label: "Status", summary: text(data?.message) ?? payload };
    case "tool_call": {
      const tool = text(data?.tool) ?? "tool";
      const args = data?.args as Record<string, unknown> | undefined;
      const detail = toolCallDetail(text(data?.result_summary), text(args?.command));
      return { label: "Tool call", summary: detail ? `${tool}: ${detail}` : tool };
    }
    case "approval":
      return { label: "Approval", summary: text(data?.reason) ?? payload };
    case "token_count":
      return {
        label: "Tokens",
        summary: data
          ? `${formatTokens(count(data.input_tokens))} in · ${formatTokens(count(data.output_tokens))} out`
          : payload,
      };
    case "error":
      return {
        label: "Error",
        summary: data
          ? `${text(data.class) ?? "Error"}: ${text(data.message) ?? ""}`
          : payload,
        tone: "error",
      };
    case "user_input":
      return { label: "User input", summary: text(data?.text) ?? payload };
    case "rate_limit":
      return {
        label: "Rate limit",
        summary: data
          ? `${text(data.source) ?? "provider"} — ${data.remaining ?? "unknown"} remaining`
          : payload,
      };
    case "humanized":
      return { label: "Summary", summary: text(data?.summary) ?? payload };
    default:
      return { label: kind, summary: "" };
  }
}

export function prettyPayload(
  value: string,
  parsed: ParsedEventPayload | undefined = parseEventPayload(value),
) {
  return parsed === undefined ? value : JSON.stringify(parsed, null, 2);
}

export function nullable(value: string) {
  return value.trim() ? value : null;
}
