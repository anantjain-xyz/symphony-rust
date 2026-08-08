// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownText } from "./MarkdownText";

afterEach(cleanup);

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
    const markdown = ["| Package | Status |", "| --- | --- |", "| renderer | fixed |"].join("\n");

    const { container } = render(
      <MarkdownText text={markdown} needle="status" firstIndex={4} currentIndex={4} />,
    );

    const marks = container.querySelectorAll('mark[data-match-index="4"]');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("Status");
    expect(marks[0].classList.contains("current")).toBe(true);
  });

  it("keeps ragged rows in the table", () => {
    render(
      <MarkdownText
        text={[
          "| Key | Value |",
          "| --- | --- |",
          "| missing |",
          "| extra | kept | ignored |",
        ].join("\n")}
      />,
    );

    const rows = screen.getByRole("table").querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].children).toHaveLength(2);
    expect(rows[0].children[0].textContent).toBe("missing");
    expect(rows[0].children[1].textContent).toBe("");
    expect(rows[1].children).toHaveLength(2);
    expect(rows[1].children[0].textContent).toBe("extra");
    expect(rows[1].children[1].textContent).toBe("kept");
  });

  it("renders one-column pipe tables", () => {
    render(<MarkdownText text={["| Status |", "| --- |", "| Fixed |"].join("\n")} />);

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "Fixed" })).toBeTruthy();
  });

  it("preserves literal backslashes in table cells", () => {
    render(
      <MarkdownText
        text={[
          "| Example | Value |",
          "| --- | --- |",
          String.raw`| Path | C:\tmp |`,
          String.raw`| Regex | \d+ |`,
        ].join("\n")}
      />,
    );

    const text = screen.getByRole("table").textContent;
    expect(text).toContain(String.raw`C:\tmp`);
    expect(text).toContain(String.raw`\d+`);
  });

  it("ignores pipes inside inline code spans when splitting table rows", () => {
    render(
      <MarkdownText
        text={["| Kind | Example |", "| --- | --- |", "| Command | `cat log | grep err` |"].join(
          "\n",
        )}
      />,
    );

    const rows = screen.getByRole("table").querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].children).toHaveLength(2);
    expect(rows[0].children[1].textContent).toBe("`cat log | grep err`");
  });

  it("keeps table-looking content inside tilde and longer backtick fences as code", () => {
    render(
      <MarkdownText
        text={[
          "~~~",
          "| Not | A table |",
          "| --- | --- |",
          "~~~",
          "",
          "````",
          "```",
          "| Also | code |",
          "```",
          "````",
        ].join("\n")}
      />,
    );

    expect(screen.queryByRole("table")).toBeNull();
    const codeBlocks = screen.getAllByText((_content, element) => element?.tagName === "CODE");
    expect(codeBlocks.map((block) => block.textContent)).toEqual([
      ["| Not | A table |", "| --- | --- |"].join("\n"),
      ["```", "| Also | code |", "```"].join("\n"),
    ]);
  });
});
