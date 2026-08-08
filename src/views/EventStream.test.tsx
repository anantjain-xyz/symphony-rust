// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventRow } from "../bindings";
import { createEventStressFixture } from "../preview/eventStressFixture";
import { EventRow, EventStream, measureEventElement } from "./EventStream";
import { prepareEvent } from "./eventStreamModel";

const eventRowProbes = vi.hoisted(() => ({ markdownText: vi.fn() }));

vi.mock("../MarkdownText", async () => {
  const actual = await vi.importActual<typeof import("../MarkdownText")>("../MarkdownText");
  return {
    ...actual,
    MarkdownText: (props: Parameters<typeof actual.MarkdownText>[0]) => {
      eventRowProbes.markdownText();
      return actual.MarkdownText(props);
    },
  };
});

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
      this.dispatchEvent(new Event("scroll"));
    }),
  });
});

afterEach(async () => {
  cleanup();
  // TanStack Virtual's fallback scroll-end observer debounces its final
  // notification for 150 ms without exposing a cancellation hook. Let that
  // callback settle while jsdom's window still exists so it cannot escape the
  // test environment after a mocked scroll.
  await new Promise((resolve) => setTimeout(resolve, 200));
});

function event(id: number, message = `event ${id}`): AgentEventRow {
  return {
    id,
    run_id: "run-1",
    kind: "status",
    payload: JSON.stringify({ message }),
    created_at: "2026-07-18T00:00:00Z",
  };
}

describe("EventStream virtualization", () => {
  it("forwards detached row refs so the virtualizer can release measurements", () => {
    const measureElement = vi.fn();
    const article = document.createElement("article");

    measureEventElement(article, 5_000, measureElement);
    measureEventElement(null, 5_000, measureElement);

    expect(article.getAttribute("aria-setsize")).toBe("5000");
    expect(measureElement).toHaveBeenNthCalledWith(1, article);
    expect(measureElement).toHaveBeenNthCalledWith(2, null);
  });

  it("bounds mounted article count for 5,000 events and exposes list position metadata", () => {
    const { container } = render(<EventStream events={createEventStressFixture()} live />);
    const articles = container.querySelectorAll("article");
    expect(articles.length).toBeGreaterThan(0);
    expect(articles.length).toBeLessThanOrEqual(60);
    expect(articles[0].getAttribute("aria-setsize")).toBe("5000");
    expect(articles[0].getAttribute("aria-posinset")).toBeTruthy();
  });

  it("searches the complete history while only mounting the virtual window", async () => {
    const rows = Array.from({ length: 5_000 }, (_, index) =>
      event(index + 1, index === 4_999 ? "unique-offscreen-match" : `ordinary ${index}`),
    );
    const { container } = render(<EventStream events={rows} live={false} />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.change(screen.getByLabelText("Search run log"), {
      target: { value: "unique-offscreen-match" },
    });

    expect(await screen.findByLabelText("2 search matches")).toBeTruthy();
    expect(vi.mocked(HTMLElement.prototype.scrollTo)).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Next match"));
    expect(container.querySelectorAll("article").length).toBeLessThanOrEqual(60);
  });

  it("keeps a memoized unchanged row from rendering again", () => {
    const model = prepareEvent(event(1));
    eventRowProbes.markdownText.mockClear();
    const props = {
      model,
      eventIndex: 0,
      start: 0,
      measureElement: vi.fn(),
      expanded: false,
      onExpandedChange: vi.fn(),
      needle: "",
      currentIndex: -1,
    };
    const row = (expanded = false) => <EventRow {...props} expanded={expanded} />;
    const { container, rerender } = render(row());
    const article = container.querySelector("article");
    expect(article).toBeTruthy();
    expect(eventRowProbes.markdownText).toHaveBeenCalledTimes(1);
    rerender(row());
    expect(container.querySelector("article")).toBe(article);
    expect(eventRowProbes.markdownText).toHaveBeenCalledTimes(1);
    rerender(row(true));
    expect(container.querySelector("article")).toBe(article);
    expect(article?.querySelector("details")?.open).toBe(true);
    expect(eventRowProbes.markdownText).toHaveBeenCalledTimes(2);
  });

  it("remeasures controlled payload expansion and pauses/resumes tail following", () => {
    const { container } = render(
      <EventStream events={Array.from({ length: 100 }, (_, index) => event(index + 1))} live />,
    );
    const scrollContainer = container.querySelector<HTMLElement>(".events")!;
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 7_600 },
      clientHeight: { configurable: true, value: 800 },
    });
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);
    expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeTruthy();

    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(details.open).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  });

  it("does not rerender unchanged mounted rows when a paused stream appends a tail", () => {
    const initial = Array.from({ length: 100 }, (_, index) => event(index + 1));
    const { container, rerender } = render(<EventStream events={initial} live />);
    const scrollContainer = container.querySelector<HTMLElement>(".events")!;
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 7_600 },
      clientHeight: { configurable: true, value: 800 },
    });
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);
    const before = new Map(
      [...container.querySelectorAll<HTMLElement>("article")].map((article) => [
        article.dataset.index,
        article,
      ]),
    );

    const appended = Array.from({ length: 100 }, (_, index) => event(index + 101));
    rerender(<EventStream events={[...initial.map((row) => ({ ...row })), ...appended]} live />);
    const after = new Map(
      [...container.querySelectorAll<HTMLElement>("article")].map((article) => [
        article.dataset.index,
        article,
      ]),
    );
    expect(before.size).toBeGreaterThan(0);
    for (const [index, article] of before) expect(after.get(index)).toBe(article);
  });

  it("preserves the empty state and single-match controls", async () => {
    const { rerender } = render(<EventStream events={[]} live={false} />);
    expect(screen.getByText("No events recorded")).toBeTruthy();
    rerender(
      <EventStream
        events={[{ ...event(1), kind: "mystery", payload: "only-once" }]}
        live={false}
      />,
    );
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(screen.getByLabelText("Search run log"), { target: { value: "only-once" } });
    expect(await screen.findByLabelText("1 search matches")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next match"));
  });

  it("reopens a collapsed payload before navigating its only match", async () => {
    const payload = JSON.stringify({ message: "ordinary", detail: "payload-only-match" });
    const { container } = render(<EventStream events={[{ ...event(1), payload }]} live={false} />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.change(screen.getByLabelText("Search run log"), {
      target: { value: "payload-only-match" },
    });

    expect(await screen.findByLabelText("1 search matches")).toBeTruthy();
    const details = container.querySelector("details")!;
    await waitFor(() => expect(details.open).toBe(true));
    details.open = false;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(details.open).toBe(false));

    fireEvent.click(screen.getByLabelText("Next match"));
    await waitFor(() => expect(details.open).toBe(true));
  });
});
