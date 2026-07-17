import { useSyncExternalStore } from "react";
import { relativeTime, shortTime, timeOnly } from "./format";

const CLOCK_INTERVAL_MS = 30_000;

export const RELATIVE_TIME_SERVER_SNAPSHOT = 0;

let snapshot = Date.now();
let timer: number | null = null;
const listeners = new Set<() => void>();

export function getRelativeTimeSnapshot() {
  return snapshot;
}

export function getRelativeTimeServerSnapshot() {
  return RELATIVE_TIME_SERVER_SNAPSHOT;
}

function publish() {
  snapshot = Date.now();
  listeners.forEach((listener) => listener());
}

function scheduleNextBoundary() {
  if (timer !== null) window.clearTimeout(timer);
  const remainder = Date.now() % CLOCK_INTERVAL_MS;
  const delay = remainder === 0 ? CLOCK_INTERVAL_MS : CLOCK_INTERVAL_MS - remainder;
  timer = window.setTimeout(() => {
    timer = null;
    publish();
    scheduleNextBoundary();
  }, delay);
}

function handleVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  publish();
  scheduleNextBoundary();
}

function startClock() {
  snapshot = Date.now();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  scheduleNextBoundary();
}

function stopClock() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

export function subscribeToRelativeTime(listener: () => void) {
  if (listeners.size === 0) startClock();
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopClock();
  };
}

export function RelativeTime({ value }: { value: string }) {
  const now = useSyncExternalStore(
    subscribeToRelativeTime,
    getRelativeTimeSnapshot,
    getRelativeTimeServerSnapshot,
  );
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return <span>{value}</span>;

  const absolute = shortTime(value);
  const relative = relativeTime(value, now);
  return (
    <time
      dateTime={date.toISOString()}
      title={absolute}
      aria-label={`${relative} — ${absolute}`}
    >
      {relative}
    </time>
  );
}

export function AbsoluteTime({ value }: { value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>{value}</span>;

  const absolute = shortTime(value);
  return (
    <time dateTime={date.toISOString()} title={absolute} aria-label={absolute}>
      {timeOnly(value)}
    </time>
  );
}
