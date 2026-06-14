// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownText, countMarkdownMatches } from "./MarkdownText";

describe("MarkdownText", () => {
  it("renders pipe tables and keeps following text outside the table", () => {
    render(
      <MarkdownText
        text={[
          "| Package | Status |",
          "| --- | --- |",
          "| renderer | fixed |",
          "Line after the table remains prose.",
        ].join("\n")}
      />,
    );

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Package" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "renderer" })).toBeTruthy();
    expect(within(table).queryByText("Line after the table remains prose.")).toBeNull();
    expect(screen.getByText("Line after the table remains prose.").tagName).toBe("P");
  });

  it("counts and highlights visible markdown text", () => {
    const markdown = ["| Package | Status |", "| --- | --- |", "| renderer | fixed |"].join(
      "\n",
    );

    expect(countMarkdownMatches(markdown, "status")).toBe(1);
    const { container } = render(
      <MarkdownText text={markdown} needle="status" firstIndex={4} currentIndex={4} />,
    );

    const mark = container.querySelector('mark[data-match-index="4"]');
    expect(mark?.textContent).toBe("Status");
    expect(mark?.classList.contains("current")).toBe(true);
  });
});
