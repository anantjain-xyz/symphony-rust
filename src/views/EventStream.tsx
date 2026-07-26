import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
} from "react";
import type { AgentEventRow } from "../bindings";
import { MarkdownText, highlightMatches } from "../MarkdownText";
import { AbsoluteTime } from "../RelativeTime";
import {
  prepareEvents,
  searchPreparedEvents,
  type EventMatchStarts,
  type PreparedEventCache,
  type PreparedEvent,
} from "./eventStreamModel";

const COLLAPSED_ROW_ESTIMATE = 76;
const OVERSCAN_ROWS = 8;
const NO_MATCH_STARTS: EventMatchStarts = { label: 0, summary: 0, payload: 0 };

export type EventRowProps = {
  model: PreparedEvent;
  eventIndex: number;
  start: number;
  measureElement: RefCallback<HTMLElement>;
  expanded: boolean;
  onExpandedChange: (key: string, expanded: boolean) => void;
  needle: string;
  matchStarts?: EventMatchStarts;
  currentIndex: number;
  onRender?: (key: string) => void;
};

function EventRowComponent({
  model,
  eventIndex,
  start,
  measureElement,
  expanded,
  onExpandedChange,
  needle,
  matchStarts = NO_MATCH_STARTS,
  currentIndex,
  onRender,
}: EventRowProps) {
  onRender?.(model.key);
  const { event, label, summary, tone, prettyPayload, summaryBlocks } = model;
  return (
    <article
      ref={measureElement}
      data-index={eventIndex}
      aria-posinset={eventIndex + 1}
      className={tone === "error" ? "event-error" : undefined}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${start}px)` }}
    >
      <div className="event-line">
        <span className="event-kind">
          {highlightMatches(label, needle, matchStarts.label, currentIndex)}
        </span>
        <div className={event.kind === "tool_call" ? "event-summary mono" : "event-summary"}>
          {summary ? (
            <MarkdownText
              blocks={summaryBlocks}
              needle={needle}
              firstIndex={matchStarts.summary}
              currentIndex={currentIndex}
            />
          ) : (
            <em>no details</em>
          )}
        </div>
        <AbsoluteTime value={event.created_at} />
      </div>
      <details
        open={expanded}
        onToggle={(toggleEvent) =>
          onExpandedChange(model.key, toggleEvent.currentTarget.open)
        }
      >
        <summary>payload</summary>
        <pre>
          {highlightMatches(prettyPayload, needle, matchStarts.payload, currentIndex)}
        </pre>
      </details>
    </article>
  );
}

export const EventRow = memo(EventRowComponent);

export function measureEventElement(
  element: HTMLElement | null,
  eventCount: number,
  measureElement: (element: HTMLElement | null) => void,
) {
  if (element) element.setAttribute("aria-setsize", String(eventCount));
  measureElement(element);
}

function centerExactMatch(container: HTMLElement | null, matchIndex: number) {
  const mark = container?.querySelector(`mark[data-match-index="${matchIndex}"]`);
  if (mark instanceof HTMLElement) mark.scrollIntoView({ block: "center", inline: "nearest" });
}

export function EventStream({
  events,
  live,
  onRowRender,
}: {
  events: AgentEventRow[];
  live: boolean;
  onRowRender?: (key: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const preparedCacheRef = useRef<PreparedEventCache>(new Map());
  const shortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const readingMatchRef = useRef(false);
  const lastCenteredMatchRef = useRef("");
  const eventCountRef = useRef(0);
  const [follow, setFollow] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  const prepared = useMemo(
    () => prepareEvents(events, preparedCacheRef.current),
    [events],
  );
  eventCountRef.current = prepared.length;
  const deferredQuery = useDeferredValue(searchOpen ? query : "");
  const search = useMemo(
    () => searchPreparedEvents(prepared, deferredQuery),
    [prepared, deferredQuery],
  );
  const totalMatches = search.totalMatches;
  const activeMatchIndex = Math.min(current, totalMatches - 1);
  const activeMatch = useMemo(
    () => search.matchAt(activeMatchIndex),
    [activeMatchIndex, search],
  );

  const virtualizer = useVirtualizer({
    count: prepared.length,
    getScrollElement: () => containerRef.current,
    // Also gives non-layout test environments a production-like viewport;
    // ResizeObserver replaces it with the real scroll element dimensions.
    initialRect: { width: 800, height: 800 },
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) =>
        callback({
          width: rect.width || 800,
          height: rect.height || 800,
        }),
      ),
    estimateSize: () => COLLAPSED_ROW_ESTIMATE,
    measureElement: (element) =>
      element.getBoundingClientRect().height || COLLAPSED_ROW_ESTIMATE,
    overscan: OVERSCAN_ROWS,
    getItemKey: (index) => prepared[index]?.key ?? index,
    useFlushSync: false,
  });
  const measureElement = useCallback<RefCallback<HTMLElement>>(
    (element) =>
      measureEventElement(element, eventCountRef.current, virtualizer.measureElement),
    [virtualizer],
  );
  const onExpandedChange = useCallback((key: string, expanded: boolean) => {
    setExpandedKeys((currentKeys) => {
      if (currentKeys.has(key) === expanded) return currentKeys;
      const next = new Set(currentKeys);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const active = new Set(prepared.map((event) => event.key));
    setExpandedKeys((currentKeys) => {
      const next = new Set([...currentKeys].filter((key) => active.has(key)));
      return next.size === currentKeys.size ? currentKeys : next;
    });
  }, [prepared]);

  useEffect(() => {
    containerRef.current?.querySelectorAll("article").forEach((article) => {
      article.setAttribute("aria-setsize", String(prepared.length));
    });
  }, [prepared.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing the search term is the effect's explicit reset signal.
  useEffect(() => {
    setCurrent(0);
  }, [search.needle]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchOpen]);

  useEffect(() => {
    if (current >= totalMatches && current !== 0) setCurrent(0);
  }, [current, totalMatches]);

  useEffect(() => {
    if (!follow || readingMatchRef.current || prepared.length === 0) return;
    virtualizer.scrollToIndex(prepared.length - 1, { align: "end" });
  }, [follow, prepared.length, virtualizer]);

  useEffect(() => {
    if (!activeMatch || !search.needle) {
      readingMatchRef.current = false;
      lastCenteredMatchRef.current = "";
      return;
    }
    const model = prepared[activeMatch.eventIndex];
    if (!model) return;
    const centerKey = `${search.needle}\u0000${current}\u0000${model.key}\u0000${activeMatch.section}\u0000${activeMatch.localIndex}`;
    if (lastCenteredMatchRef.current === centerKey) return;
    lastCenteredMatchRef.current = centerKey;
    readingMatchRef.current = true;
    setFollow(false);
    if (activeMatch.section === "payload" && model) {
      setExpandedKeys((keys) => (keys.has(model.key) ? keys : new Set(keys).add(model.key)));
    }
    virtualizer.scrollToIndex(activeMatch.eventIndex, { align: "center" });
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => centerExactMatch(containerRef.current, current));
    });
    return () => cancelAnimationFrame(frame);
  }, [activeMatch, current, prepared, search.needle, virtualizer]);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (totalMatches === 0) return;
      readingMatchRef.current = true;
      setFollow(false);
      if (totalMatches === 1) {
        const only = search.matchAt(0);
        if (!only) return;
        const model = prepared[only.eventIndex];
        if (only.section === "payload" && model) {
          setExpandedKeys((keys) => (keys.has(model.key) ? keys : new Set(keys).add(model.key)));
        }
        virtualizer.scrollToIndex(only.eventIndex, { align: "center" });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => centerExactMatch(containerRef.current, 0)),
        );
        return;
      }
      setCurrent((previous) => (previous + direction + totalMatches) % totalMatches);
    },
    [prepared, search, totalMatches, virtualizer],
  );

  shortcutHandlerRef.current = (keyboardEvent) => {
    const findShortcut =
      (keyboardEvent.metaKey || keyboardEvent.ctrlKey) &&
      !keyboardEvent.altKey &&
      !keyboardEvent.shiftKey &&
      keyboardEvent.key.toLocaleLowerCase() === "f";
    if (findShortcut && prepared.length > 0) {
      keyboardEvent.preventDefault();
      if (searchOpen) {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else {
        setSearchOpen(true);
      }
    } else if (keyboardEvent.key === "Escape" && searchOpen) {
      keyboardEvent.preventDefault();
      setSearchOpen(false);
      readingMatchRef.current = false;
    }
  };
  useEffect(() => {
    const listener = (keyboardEvent: KeyboardEvent) => shortcutHandlerRef.current(keyboardEvent);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  if (prepared.length === 0) {
    return (
      <div className="empty">
        <strong>No events recorded</strong>
        <span>This run has no agent events yet.</span>
      </div>
    );
  }

  const activeEventIndex = activeMatch?.eventIndex ?? -1;
  return (
    <div className="events-wrap">
      {searchOpen ? (
        // biome-ignore lint/a11y/useSemanticElements: role=search retains compatibility with the desktop webview and jsdom.
        <div className="event-search" role="search">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            placeholder="Search events…"
            aria-label="Search run log"
            onChange={(changeEvent) => setQuery(changeEvent.target.value)}
            onKeyDown={(keyboardEvent) => {
              if (keyboardEvent.key === "Enter") {
                keyboardEvent.preventDefault();
                step(keyboardEvent.shiftKey ? -1 : 1);
              }
            }}
          />
          {search.needle ? (
            <span
              className="event-search-count tnum"
              role="status"
              aria-live="polite"
              aria-label={`${totalMatches} search matches`}
            >
              {totalMatches === 0 ? "0/0" : `${Math.min(current + 1, totalMatches)}/${totalMatches}`}
            </span>
          ) : null}
          <button type="button" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={totalMatches === 0} onMouseDown={(event) => event.preventDefault()} onClick={() => step(-1)}>↑</button>
          <button type="button" title="Next match (Enter)" aria-label="Next match" disabled={totalMatches === 0} onMouseDown={(event) => event.preventDefault()} onClick={() => step(1)}>↓</button>
          <button type="button" title="Close (Esc)" aria-label="Close search" onClick={() => { setSearchOpen(false); readingMatchRef.current = false; }}>✕</button>
        </div>
      ) : null}
      <div
        className="events"
        ref={containerRef}
        onScroll={() => {
          const element = containerRef.current;
          if (!element) return;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
          if (!atBottom) readingMatchRef.current = readingMatchRef.current || Boolean(search.needle);
          setFollow(atBottom && !readingMatchRef.current);
        }}
      >
        <div className="events-virtual" style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const model = prepared[virtualRow.index];
            const starts = search.starts.get(model.key);
            return (
              <EventRow
                key={model.key}
                model={model}
                eventIndex={virtualRow.index}
                start={virtualRow.start}
                measureElement={measureElement}
                expanded={expandedKeys.has(model.key)}
                onExpandedChange={onExpandedChange}
                needle={starts ? search.needle : ""}
                matchStarts={starts}
                currentIndex={virtualRow.index === activeEventIndex ? current : -1}
                onRender={onRowRender}
              />
            );
          })}
        </div>
      </div>
      {!follow && live ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            readingMatchRef.current = false;
            virtualizer.scrollToIndex(prepared.length - 1, { align: "end" });
            setFollow(true);
          }}
        >
          Jump to latest ↓
        </button>
      ) : null}
    </div>
  );
}
