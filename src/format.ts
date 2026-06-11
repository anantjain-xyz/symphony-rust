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

export function describeEvent(kind: string, payload: string): EventSummary {
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = null;
  }
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const count = (value: unknown) => (typeof value === "number" ? value : 0);

  switch (kind) {
    case "status":
      return { label: "Status", summary: text(data?.message) ?? payload };
    case "tool_call": {
      const tool = text(data?.tool) ?? "tool";
      const args = data?.args as Record<string, unknown> | undefined;
      const detail = text(data?.result_summary) ?? text(args?.command) ?? "";
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

export function prettyPayload(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function nullable(value: string) {
  return value.trim() ? value : null;
}
