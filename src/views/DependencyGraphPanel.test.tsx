import { describe, expect, it, vi } from "vitest";
import type { IssueRow } from "../bindings";
import {
  buildDependencyGraph,
  getDependencyGraphModel,
} from "./DependencyGraphPanel";

function issue(identifier: string, blockers: unknown[] = []): IssueRow {
  return {
    id: `issue-${identifier}`,
    identifier,
    title: `Title for ${identifier}`,
    description: null,
    priority: 2,
    state: "Todo",
    branch: null,
    labels: "[]",
    blockers: JSON.stringify(blockers),
    pr_urls: "[]",
    raw: "{}",
    last_seen_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("buildDependencyGraph", () => {
  it("preserves the preview graph ordering, labels, and blocker direction", () => {
    const graph = buildDependencyGraph([
      issue("SYM-58"),
      issue("SYM-61", ["SYM-60"]),
      issue("SYM-57"),
    ]);

    expect({
      nodes: graph.nodes.map((node) => ({
        identifier: node.identifier,
        external: node.external,
        layer: node.layer,
        row: node.row,
        x: node.x,
        y: node.y,
        blocksCount: node.blocksCount,
        blockedByCount: node.blockedByCount,
      })),
      edges: graph.edges,
      width: graph.width,
      height: graph.height,
      issueCount: graph.issueCount,
      blockedIssueCount: graph.blockedIssueCount,
      externalBlockerCount: graph.externalBlockerCount,
    }).toMatchInlineSnapshot(`
      {
        "blockedIssueCount": 1,
        "edges": [
          {
            "external": true,
            "from": "SYM-60",
            "to": "SYM-61",
          },
        ],
        "externalBlockerCount": 1,
        "height": 342,
        "issueCount": 3,
        "nodes": [
          {
            "blockedByCount": 0,
            "blocksCount": 1,
            "external": true,
            "identifier": "SYM-60",
            "layer": 0,
            "row": 0,
            "x": 24,
            "y": 24,
          },
          {
            "blockedByCount": 0,
            "blocksCount": 0,
            "external": false,
            "identifier": "SYM-58",
            "layer": 0,
            "row": 1,
            "x": 24,
            "y": 128,
          },
          {
            "blockedByCount": 0,
            "blocksCount": 0,
            "external": false,
            "identifier": "SYM-57",
            "layer": 0,
            "row": 2,
            "x": 24,
            "y": 232,
          },
          {
            "blockedByCount": 1,
            "blocksCount": 0,
            "external": false,
            "identifier": "SYM-61",
            "layer": 1,
            "row": 0,
            "x": 332,
            "y": 24,
          },
        ],
        "width": 572,
      }
    `);
  });

  it("handles cycles and de-duplicates repeated relations deterministically", () => {
    const graph = buildDependencyGraph([
      issue("SYM-1", ["SYM-2", "SYM-2"]),
      issue("SYM-2", ["SYM-1"]),
    ]);

    expect(graph.edges).toEqual([
      { from: "SYM-1", to: "SYM-2", external: false },
      { from: "SYM-2", to: "SYM-1", external: false },
    ]);
    expect(graph.nodes.map(({ identifier, layer }) => ({ identifier, layer }))).toEqual([
      { identifier: "SYM-2", layer: 1 },
      { identifier: "SYM-1", layer: 2 },
    ]);
  });

  it("omits malformed relation targets while retaining every watched issue node", () => {
    const malformed = issue("SYM-2");
    malformed.blockers = JSON.stringify([null, 42, "", "missing", "SYM-1", "OPS-9"]);
    const graph = buildDependencyGraph([issue("SYM-1"), malformed]);

    expect(graph.nodes.map((node) => node.identifier)).toEqual(["OPS-9", "SYM-1", "SYM-2"]);
    expect(graph.edges).toEqual([
      { from: "SYM-1", to: "SYM-2", external: false },
      { from: "OPS-9", to: "SYM-2", external: true },
    ]);
  });

  it("returns an immutable empty-edge model when no issues have blockers", () => {
    const graph = buildDependencyGraph([issue("SYM-1"), issue("SYM-2")]);

    expect(graph.edges).toEqual([]);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(graph.nodes.every(Object.isFrozen)).toBe(true);
  });

  it("builds a stable model for hundreds of issues", () => {
    const issues = Array.from({ length: 500 }, (_, index) =>
      issue(`SYM-${index + 1}`, index === 0 ? [] : [`SYM-${index}`]),
    );
    const graph = buildDependencyGraph(issues);

    expect(graph.issueCount).toBe(500);
    expect(graph.nodes).toHaveLength(500);
    expect(graph.edges).toHaveLength(499);
    expect(graph.externalBlockerCount).toBe(0);
  });
});

describe("getDependencyGraphModel", () => {
  it("reuses one build for the identical snapshot and builds once for a new array", () => {
    const snapshot = [issue("SYM-1")];
    const expected = buildDependencyGraph(snapshot);
    const builder = vi.fn((_: readonly IssueRow[]) => expected);

    expect(getDependencyGraphModel(snapshot, builder)).toBe(expected);
    expect(getDependencyGraphModel(snapshot, builder)).toBe(expected);
    expect(builder).toHaveBeenCalledTimes(1);

    const replacement = [...snapshot];
    expect(getDependencyGraphModel(replacement, builder)).toBe(expected);
    expect(builder).toHaveBeenCalledTimes(2);
    expect(builder.mock.calls[0]?.[0]).toBe(snapshot);
    expect(builder.mock.calls[1]?.[0]).toBe(replacement);
  });
});
