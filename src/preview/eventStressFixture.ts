import type { AgentEventRow } from "../bindings";

const LONG_MARKDOWN = [
  "Inspecting a production-sized event stream with wrapped Markdown.",
  "",
  "| Phase | Result | Detail |",
  "| --- | --- | --- |",
  "| prepare | ready | Parsed payload and Markdown are cached by stable revision. |",
  "| render | ready | Dynamic rows are measured after wrapping and expansion. |",
  "",
  "```text",
  "A deliberately long line verifies that variable-width content wraps without overlapping the next virtual row while search highlighting remains in document order.",
  "```",
].join("\n");

export function createEventStressFixture(count = 5_000): AgentEventRow[] {
  const startedAt = Date.UTC(2026, 6, 18, 18, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const common = {
      id: 10_000 + index,
      run_id: "preview-run-stress",
      created_at: new Date(startedAt + index * 1_000).toISOString(),
    };
    if (index % 197 === 0) {
      return { ...common, kind: "status", payload: `malformed payload ${index} {` };
    }
    if (index % 11 === 0) {
      return {
        ...common,
        kind: "status",
        payload: JSON.stringify({ message: `${LONG_MARKDOWN}\n\nEvent fixture ${index}.` }),
      };
    }
    if (index % 7 === 0) {
      return {
        ...common,
        kind: "error",
        payload: JSON.stringify({
          class: "StressFixtureError",
          message: `Recoverable fixture error ${index}`,
          context: {
            index,
            retryable: true,
            values: Array.from({ length: 30 }, (_, value) => value),
          },
        }),
      };
    }
    if (index % 3 === 0) {
      return {
        ...common,
        kind: "tool_call",
        payload: JSON.stringify({
          tool: "bash",
          args: { command: `pnpm test -- shard-${index % 16}` },
          result_summary: index % 2 === 0 ? "exit 0" : "running",
          output: "expanded payload fixture ".repeat(12),
        }),
      };
    }
    return {
      ...common,
      kind: "token_count",
      payload: JSON.stringify({ input_tokens: index * 31, output_tokens: index * 7 }),
    };
  });
}
