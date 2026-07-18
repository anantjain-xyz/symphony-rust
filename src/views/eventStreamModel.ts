import type { AgentEventRow } from "../bindings";
import {
  type MarkdownBlock,
  parseMarkdownBlocks,
} from "../MarkdownText";
import {
  describeEvent,
  EVENT_PAYLOAD_PARSE_FAILED,
  parseEventPayload,
  prettyPayload,
  type ParsedEventPayload,
} from "../format";

export type PreparedEvent = {
  event: AgentEventRow;
  key: string;
  parsedJson: ParsedEventPayload | undefined;
  label: string;
  tone?: "error";
  summary: string;
  prettyPayload: string;
  summaryBlocks: MarkdownBlock[];
  normalizedSearchText: string;
  normalizedSections: {
    label: string;
    summary: string[];
    payload: string;
  };
};

export type EventMatch = {
  eventIndex: number;
  section: "label" | "summary" | "payload";
  localIndex: number;
};

export type EventMatchStarts = {
  label: number;
  summary: number;
  payload: number;
};

export type PrepareInstrumentation = {
  parsedPayload?: () => void;
  parsedMarkdown?: () => void;
  builtRevisionKey?: () => void;
};

type PreparedEventCacheEntry = {
  kind: string;
  payload: string;
  createdAt: string;
  model: PreparedEvent;
};

export type PreparedEventCache = Map<number, PreparedEventCacheEntry>;

type EventMatchSpan = {
  eventIndex: number;
  section: EventMatch["section"];
  start: number;
  count: number;
};

export function eventRevisionKey(event: AgentEventRow) {
  return `${event.id}\u0000${event.kind}\u0000${event.payload}\u0000${event.created_at}`;
}

function markdownSegments(blocks: MarkdownBlock[]) {
  return blocks.flatMap((block) => {
    if (block.type === "paragraph") return block.lines;
    if (block.type === "code") return [block.text];
    return [...block.headers, ...block.rows.flat()];
  });
}

export function prepareEvent(
  event: AgentEventRow,
  instrumentation?: PrepareInstrumentation,
): PreparedEvent {
  instrumentation?.parsedPayload?.();
  const parsedJson = parseEventPayload(event.payload);
  const { label, summary, tone } = describeEvent(event.kind, event.payload, parsedJson);
  const pretty = prettyPayload(event.payload, parsedJson);
  instrumentation?.parsedMarkdown?.();
  const summaryBlocks = parseMarkdownBlocks(summary);
  const normalizedSections = {
    label: label.toLowerCase(),
    summary: markdownSegments(summaryBlocks).map((text) => text.toLowerCase()),
    payload: pretty.toLowerCase(),
  };
  instrumentation?.builtRevisionKey?.();
  return {
    event,
    key: eventRevisionKey(event),
    parsedJson: parsedJson === EVENT_PAYLOAD_PARSE_FAILED ? undefined : parsedJson,
    label,
    tone,
    summary,
    prettyPayload: pretty,
    summaryBlocks,
    normalizedSearchText: [
      normalizedSections.label,
      ...normalizedSections.summary,
      normalizedSections.payload,
    ].join("\n"),
    normalizedSections,
  };
}

export function prepareEvents(
  events: AgentEventRow[],
  cache: PreparedEventCache,
  instrumentation?: PrepareInstrumentation,
) {
  const seenIds = new Set<number>();
  const prepared: PreparedEvent[] = [];
  for (const event of events) {
    if (event.kind === "humanized" || seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    const cached = cache.get(event.id);
    const unchanged =
      cached &&
      cached.kind === event.kind &&
      cached.payload === event.payload &&
      cached.createdAt === event.created_at;
    let model: PreparedEvent;
    if (unchanged) {
      model = cached.model;
    } else {
      model = prepareEvent(event, instrumentation);
      cache.set(event.id, {
        kind: event.kind,
        payload: event.payload,
        createdAt: event.created_at,
        model,
      });
    }
    prepared.push(model);
  }
  for (const id of cache.keys()) {
    if (!seenIds.has(id)) cache.delete(id);
  }
  return prepared;
}

function countNormalizedMatches(text: string, needle: string) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

export function searchPreparedEvents(events: PreparedEvent[], query: string) {
  const needle = query.toLowerCase();
  const matchSpans: EventMatchSpan[] = [];
  const starts = new Map<string, EventMatchStarts>();
  let totalMatches = 0;

  const matchAt = (matchIndex: number): EventMatch | null => {
    if (matchIndex < 0 || matchIndex >= totalMatches) return null;
    let low = 0;
    let high = matchSpans.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const span = matchSpans[middle];
      if (matchIndex < span.start) high = middle - 1;
      else if (matchIndex >= span.start + span.count) low = middle + 1;
      else {
        return {
          eventIndex: span.eventIndex,
          section: span.section,
          localIndex: matchIndex - span.start,
        };
      }
    }
    return null;
  };

  if (!needle) return { needle, totalMatches, matchSpans, matchAt, starts };

  const addSpan = (
    eventIndex: number,
    section: EventMatch["section"],
    count: number,
  ) => {
    if (count === 0) return;
    matchSpans.push({ eventIndex, section, start: totalMatches, count });
    totalMatches += count;
  };

  events.forEach((event, eventIndex) => {
    if (!event.normalizedSearchText.includes(needle)) return;
    const eventStart = totalMatches;
    const eventStarts = {
      label: totalMatches,
      summary: 0,
      payload: 0,
    };
    const labelMatches = countNormalizedMatches(event.normalizedSections.label, needle);
    addSpan(eventIndex, "label", labelMatches);
    eventStarts.summary = totalMatches;
    let summaryMatches = 0;
    for (const segment of event.normalizedSections.summary) {
      summaryMatches += countNormalizedMatches(segment, needle);
    }
    addSpan(eventIndex, "summary", summaryMatches);
    eventStarts.payload = totalMatches;
    const payloadMatches = countNormalizedMatches(event.normalizedSections.payload, needle);
    addSpan(eventIndex, "payload", payloadMatches);
    if (totalMatches > eventStart) starts.set(event.key, eventStarts);
  });
  return { needle, totalMatches, matchSpans, matchAt, starts };
}
