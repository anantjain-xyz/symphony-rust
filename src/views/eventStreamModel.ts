import type { AgentEventRow } from "../bindings";
import {
  type MarkdownBlock,
  parseMarkdownBlocks,
} from "../MarkdownText";
import {
  describeEvent,
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
    label: label.toLocaleLowerCase(),
    summary: markdownSegments(summaryBlocks).map((text) => text.toLocaleLowerCase()),
    payload: pretty.toLocaleLowerCase(),
  };
  return {
    event,
    key: eventRevisionKey(event),
    parsedJson,
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
  cache: Map<string, PreparedEvent>,
  instrumentation?: PrepareInstrumentation,
) {
  const seenIds = new Set<number>();
  const activeKeys = new Set<string>();
  const prepared: PreparedEvent[] = [];
  for (const event of events) {
    if (event.kind === "humanized" || seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    const key = eventRevisionKey(event);
    activeKeys.add(key);
    let model = cache.get(key);
    if (!model) {
      model = prepareEvent(event, instrumentation);
      cache.set(key, model);
    }
    prepared.push(model);
  }
  for (const key of cache.keys()) {
    if (!activeKeys.has(key)) cache.delete(key);
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
  const needle = query.toLocaleLowerCase();
  const matches: EventMatch[] = [];
  const starts = new Map<string, EventMatchStarts>();
  if (!needle) return { needle, matches, starts };

  events.forEach((event, eventIndex) => {
    if (!event.normalizedSearchText.includes(needle)) return;
    const eventStarts = {
      label: matches.length,
      summary: 0,
      payload: 0,
    };
    const labelMatches = countNormalizedMatches(event.normalizedSections.label, needle);
    for (let localIndex = 0; localIndex < labelMatches; localIndex += 1) {
      matches.push({ eventIndex, section: "label", localIndex });
    }
    eventStarts.summary = matches.length;
    let summaryLocalIndex = 0;
    for (const segment of event.normalizedSections.summary) {
      const count = countNormalizedMatches(segment, needle);
      for (let segmentIndex = 0; segmentIndex < count; segmentIndex += 1) {
        matches.push({ eventIndex, section: "summary", localIndex: summaryLocalIndex });
        summaryLocalIndex += 1;
      }
    }
    eventStarts.payload = matches.length;
    const payloadMatches = countNormalizedMatches(event.normalizedSections.payload, needle);
    for (let localIndex = 0; localIndex < payloadMatches; localIndex += 1) {
      matches.push({ eventIndex, section: "payload", localIndex });
    }
    starts.set(event.key, eventStarts);
  });
  return { needle, matches, starts };
}
