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
