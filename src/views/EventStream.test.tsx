// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventRow } from "../bindings";
import { createEventStressFixture } from "../preview/eventStressFixture";
import { EventRow, EventStream } from "./EventStream";
import { prepareEvent } from "./eventStreamModel";

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

afterEach(cleanup);

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
    const onRender = vi.fn();
    const props = {
      model,
      eventIndex: 0,
      start: 0,
      measureElement: vi.fn(),
      expanded: false,
      onExpandedChange: vi.fn(),
      needle: "",
      currentIndex: -1,
      onRender,
    };
    const { rerender } = render(<EventRow {...props} />);
    rerender(<EventRow {...props} />);
    expect(onRender).toHaveBeenCalledTimes(1);
    rerender(<EventRow {...props} expanded />);
    expect(onRender).toHaveBeenCalledTimes(2);
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
    const onRowRender = vi.fn();
    const { container, rerender } = render(
      <EventStream events={initial} live onRowRender={onRowRender} />,
    );
    const scrollContainer = container.querySelector<HTMLElement>(".events")!;
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 7_600 },
      clientHeight: { configurable: true, value: 800 },
    });
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);
    onRowRender.mockClear();

    const appended = Array.from({ length: 100 }, (_, index) => event(index + 101));
    rerender(<EventStream events={[...initial.map((row) => ({ ...row })), ...appended]} live onRowRender={onRowRender} />);
    expect(onRowRender).not.toHaveBeenCalled();
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
});
