// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AbsoluteTime,
  RELATIVE_TIME_SERVER_SNAPSHOT,
  RelativeTime,
  getRelativeTimeServerSnapshot,
  getRelativeTimeSnapshot,
  subscribeToRelativeTime,
} from "./RelativeTime";

const BASE_TIME = new Date("2026-06-10T12:00:12.345Z");

describe("relative-time clock", () => {
  let visibilityState = "visible";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("shares one timer and stops it after the last subscriber leaves", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeToRelativeTime(first);
    const unsubscribeSecond = subscribeToRelativeTime(second);

    expect(vi.getTimerCount()).toBe(1);
    unsubscribeFirst();
    expect(vi.getTimerCount()).toBe(1);
    unsubscribeSecond();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ticks on the next aligned 30-second boundary", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToRelativeTime(listener);

    vi.advanceTimersByTime(17_654);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getRelativeTimeSnapshot()).toBe(new Date("2026-06-10T12:00:30.000Z").getTime());
    expect(vi.getTimerCount()).toBe(1);
    unsubscribe();
  });

  it("publishes immediately on visibility restoration and realigns", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToRelativeTime(listener);
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5_000);

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getRelativeTimeSnapshot()).toBe(BASE_TIME.getTime() + 5_000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(12_654);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("exports a deterministic server snapshot", () => {
    expect(getRelativeTimeServerSnapshot()).toBe(RELATIVE_TIME_SERVER_SNAPSHOT);
    expect(RELATIVE_TIME_SERVER_SNAPSHOT).toBe(0);
  });
});

describe("RelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("updates only the subscribed timestamp on a clock tick", () => {
    let parentRenders = 0;
    let expensiveSiblingRenders = 0;

    function ExpensiveSibling() {
      expensiveSiblingRenders += 1;
      return <div>expensive view</div>;
    }

    function InstrumentedView() {
      parentRenders += 1;
      return (
        <section>
          <ExpensiveSibling />
          <RelativeTime value="2026-06-10T11:59:28.000Z" />
        </section>
      );
    }

    render(<InstrumentedView />);
    expect(screen.getByText("just now")).toBeTruthy();

    act(() => vi.advanceTimersByTime(17_655));

    expect(screen.getByText("1m ago")).toBeTruthy();
    expect(parentRenders).toBe(1);
    expect(expensiveSiblingRenders).toBe(1);
  });

  it("renders machine-readable and absolute timestamp affordances", () => {
    const { container } = render(<RelativeTime value="2026-06-10T11:59:28.000Z" />);
    const time = container.querySelector("time");

    expect(time?.dateTime).toBe("2026-06-10T11:59:28.000Z");
    expect(time?.title).toBeTruthy();
    expect(time?.getAttribute("aria-label")).toContain(time?.title ?? "missing");
  });

  it("does not emit an invalid time element", () => {
    const { container } = render(<RelativeTime value="not a date" />);
    expect(container.querySelector("time")).toBeNull();
    expect(screen.getByText("not a date")).toBeTruthy();
  });

  it("keeps absolute event times machine-readable and accessible", () => {
    const { container, rerender } = render(<AbsoluteTime value="2026-06-10T11:59:28.000Z" />);
    const time = container.querySelector("time");

    expect(time?.dateTime).toBe("2026-06-10T11:59:28.000Z");
    expect(time?.title).toBeTruthy();
    expect(time?.getAttribute("aria-label")).toBe(time?.title);

    rerender(<AbsoluteTime value="not a date" />);
    expect(container.querySelector("time")).toBeNull();
  });
});
