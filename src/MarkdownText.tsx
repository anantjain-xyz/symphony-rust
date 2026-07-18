import { Fragment, type CSSProperties, type ReactNode } from "react";

type Alignment = "left" | "center" | "right" | undefined;

export type MarkdownBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "code"; text: string; language: string | null }
  | {
      type: "table";
      headers: string[];
      alignments: Alignment[];
      rows: string[][];
    };

type Fence = { marker: "`" | "~"; length: number; language: string | null };

export function countMatches(text: string, needle: string) {
  const normalizedNeedle = needle.toLowerCase();
  if (!normalizedNeedle) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  let at = haystack.indexOf(normalizedNeedle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(normalizedNeedle, at + normalizedNeedle.length);
  }
  return count;
}

export function countMarkdownMatches(text: string, needle: string) {
  if (!needle) return 0;
  return countPreparedMarkdownMatches(parseMarkdownBlocks(text), needle);
}

export function countPreparedMarkdownMatches(blocks: MarkdownBlock[], needle: string) {
  if (!needle) return 0;
  return blocks.reduce((total, block) => {
    if (block.type === "paragraph") {
      return (
        total +
        block.lines.reduce((lineTotal, line) => lineTotal + countMatches(line, needle), 0)
      );
    }
    if (block.type === "code") {
      return total + countMatches(block.text, needle);
    }
    return (
      total +
      block.headers.reduce((sum, cell) => sum + countMatches(cell, needle), 0) +
      block.rows.reduce(
        (rowSum, row) =>
          rowSum + row.reduce((cellSum, cell) => cellSum + countMatches(cell, needle), 0),
        0,
      )
    );
  }, 0);
}

export function highlightMatches(
  text: string,
  needle: string,
  firstIndex: number,
  currentIndex: number,
): ReactNode {
  const normalizedNeedle = needle.toLowerCase();
  if (!normalizedNeedle) return text;
  const haystack = text.toLowerCase();
  let at = haystack.indexOf(normalizedNeedle);
  if (at === -1) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = firstIndex;
  while (at !== -1) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark
        key={matchIndex}
        data-match-index={matchIndex}
        className={matchIndex === currentIndex ? "search-hit current" : "search-hit"}
      >
        {text.slice(at, at + normalizedNeedle.length)}
      </mark>,
    );
    matchIndex += 1;
    cursor = at + normalizedNeedle.length;
    at = haystack.indexOf(normalizedNeedle, cursor);
  }
  parts.push(text.slice(cursor));
  return parts;
}

export function MarkdownText({
  text,
  blocks: preparedBlocks,
  needle = "",
  firstIndex = 0,
  currentIndex = -1,
}: {
  text?: string;
  blocks?: MarkdownBlock[];
  needle?: string;
  firstIndex?: number;
  currentIndex?: number;
}) {
  const blocks = preparedBlocks ?? parseMarkdownBlocks(text ?? "");
  const matchIndex = { current: firstIndex };
  const renderText = (value: string) => {
    const rendered = highlightMatches(value, needle, matchIndex.current, currentIndex);
    matchIndex.current += countMatches(value, needle);
    return rendered;
  };

  return (
    <div className="markdown-text">
      {blocks.map((block, index) => {
        if (block.type === "paragraph") {
          return (
            <p key={index}>
              {block.lines.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex > 0 ? <br /> : null}
                  {renderText(line)}
                </Fragment>
              ))}
            </p>
          );
        }
        if (block.type === "code") {
          return (
            <pre key={index} className="markdown-code">
              <code>{renderText(block.text)}</code>
            </pre>
          );
        }
        return (
          <div key={index} className="markdown-table-wrap">
            <table className="markdown-table">
              <thead>
                <tr>
                  {block.headers.map((cell, cellIndex) => (
                    <th key={cellIndex} style={textAlignStyle(block.alignments[cellIndex])}>
                      {renderText(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} style={textAlignStyle(block.alignments[cellIndex])}>
                        {renderText(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index].trim() === "") {
      index += 1;
      continue;
    }

    const fence = parseFenceStart(lines[index]);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !isFenceEnd(lines[index], fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: "code",
        language: fence.language,
        text: codeLines.join("\n"),
      });
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !parseFenceStart(lines[index]) &&
      !parseTable(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    if (paragraphLines.length > 0) blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

function parseFenceStart(line: string): Fence | null {
  const match = line.trimStart().match(/^(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const marker = match[1][0] as "`" | "~";
  const info = match[2].trim();
  if (marker === "`" && info.includes("`")) return null;
  return {
    marker,
    length: match[1].length,
    language: info.split(/\s+/, 1)[0] || null,
  };
}

function isFenceEnd(line: string, fence: Fence) {
  const trimmed = line.trim();
  const pattern = fence.marker === "`" ? /^`+$/ : /^~+$/;
  return pattern.test(trimmed) && trimmed.length >= fence.length;
}

function parseTable(
  lines: string[],
  index: number,
): { block: Extract<MarkdownBlock, { type: "table" }>; nextIndex: number } | null {
  const headers = splitTableRow(lines[index]);
  if (!headers || index + 1 >= lines.length) return null;
  const alignments = parseDelimiterRow(lines[index + 1], headers.length);
  if (!alignments) return null;

  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && lines[nextIndex].trim() !== "") {
    const row = splitTableRow(lines[nextIndex]);
    if (!row) break;
    rows.push(fitTableRow(row, headers.length));
    nextIndex += 1;
  }

  return {
    block: { type: "table", headers, alignments, rows },
    nextIndex,
  };
}

function splitTableRow(line: string): string[] | null {
  let row = line.trim();
  if (!row.includes("|")) return null;
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let codeSpanTicks = 0;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === "`") {
      const tickCount = countRun(row, index, "`");
      cell += row.slice(index, index + tickCount);
      if (codeSpanTicks === 0) {
        codeSpanTicks = tickCount;
      } else if (tickCount === codeSpanTicks) {
        codeSpanTicks = 0;
      }
      index += tickCount - 1;
    } else if (char === "\\" && row[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|" && codeSpanTicks === 0) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());

  return cells.length >= 1 ? cells : null;
}

function parseDelimiterRow(line: string, expectedCells: number): Alignment[] | null {
  const cells = splitTableRow(line);
  if (!cells || cells.length !== expectedCells) return null;
  const alignments: Alignment[] = [];
  for (const cell of cells) {
    const normalized = cell.replace(/\s+/g, "");
    if (!/^:?-{3,}:?$/.test(normalized)) return null;
    const left = normalized.startsWith(":");
    const right = normalized.endsWith(":");
    alignments.push(left && right ? "center" : right ? "right" : left ? "left" : undefined);
  }
  return alignments;
}

function fitTableRow(row: string[], width: number) {
  if (row.length === width) return row;
  if (row.length > width) return row.slice(0, width);
  return [...row, ...Array.from({ length: width - row.length }, () => "")];
}

function countRun(value: string, start: number, char: string) {
  let end = start;
  while (end < value.length && value[end] === char) end += 1;
  return end - start;
}

function textAlignStyle(alignment: Alignment): CSSProperties | undefined {
  return alignment ? { textAlign: alignment } : undefined;
}
