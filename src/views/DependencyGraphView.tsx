import type { IssueRow } from "../bindings";
import { statusSlug } from "../format";
import "./DependencyGraphView.css";

const DEPENDENCY_NODE_WIDTH = 216;
const DEPENDENCY_NODE_HEIGHT = 86;
const DEPENDENCY_LAYER_GAP = 92;
const DEPENDENCY_ROW_GAP = 18;
const DEPENDENCY_PADDING = 24;

type DependencyGraph = {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  width: number;
  height: number;
  issueCount: number;
  blockedIssueCount: number;
  externalBlockerCount: number;
};

type DependencyNode = {
  identifier: string;
  issue: IssueRow | null;
  external: boolean;
  layer: number;
  row: number;
  x: number;
  y: number;
  blocksCount: number;
  blockedByCount: number;
};

type DependencyEdge = {
  from: string;
  to: string;
  external: boolean;
};

function DependencyGraphView({ graph }: { graph: DependencyGraph }) {
  if (graph.edges.length === 0) {
    return (
      <Empty
        title="No blocking dependencies"
        text="None of the watched issues currently list an open blocker."
      />
    );
  }

  const nodesByIdentifier = new Map(graph.nodes.map((node) => [node.identifier, node]));

  return (
    <div className="dependency-view">
      <div className="dependency-summary" aria-label="Dependency summary">
        <DependencyStat label="Watched issues" value={graph.issueCount} />
        <DependencyStat label="Blocked issues" value={graph.blockedIssueCount} />
        <DependencyStat label="Blocking links" value={graph.edges.length} />
        <DependencyStat label="External blockers" value={graph.externalBlockerCount} />
      </div>
      <div
        className="dependency-graph-shell"
        role="group"
        aria-label={`Dependency graph with ${graph.nodes.length} nodes and ${graph.edges.length} blocking links`}
      >
        <div
          className="dependency-graph-canvas"
          style={{ width: graph.width, height: graph.height }}
        >
          <svg
            className="dependency-edges"
            viewBox={`0 0 ${graph.width} ${graph.height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="dependency-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const from = nodesByIdentifier.get(edge.from);
              const to = nodesByIdentifier.get(edge.to);
              if (!from || !to) return null;
              const startX = from.x + DEPENDENCY_NODE_WIDTH;
              const startY = from.y + DEPENDENCY_NODE_HEIGHT / 2;
              const endX = to.x - 8;
              const endY = to.y + DEPENDENCY_NODE_HEIGHT / 2;
              const control = Math.max(44, Math.abs(endX - startX) / 2);
              const path =
                endX > startX
                  ? `M ${startX} ${startY} C ${startX + control} ${startY} ${endX - control} ${endY} ${endX} ${endY}`
                  : `M ${startX} ${startY} C ${startX + control} ${startY} ${startX + control} ${endY} ${endX} ${endY}`;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  className={edge.external ? "dependency-edge external" : "dependency-edge"}
                  d={path}
                  markerEnd="url(#dependency-arrow)"
                />
              );
            })}
          </svg>
          {graph.nodes.map((node) => (
            <DependencyNodeCard key={node.identifier} node={node} />
          ))}
        </div>
      </div>
      <div className="dependency-links">
        <h4>Blocking links</h4>
        <ul aria-label="Blocking links">
          {graph.edges.map((edge) => (
            <li key={`${edge.from}->${edge.to}`} aria-label={`${edge.from} blocks ${edge.to}`}>
              <strong>{edge.from}</strong>
              <span>blocks</span>
              <strong>{edge.to}</strong>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DependencyStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="dependency-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function DependencyNodeCard({ node }: { node: DependencyNode }) {
  const className = [
    "dependency-node",
    node.external ? "external" : "watched",
    node.blockedByCount > 0 ? "blocked" : "",
    node.blocksCount > 0 ? "blocker" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={className}
      style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
      aria-label={
        node.external
          ? `${node.identifier}, external blocker`
          : `${node.identifier}, ${node.issue?.title ?? "watched issue"}`
      }
    >
      <div className="dependency-node-head">
        <strong>{node.identifier}</strong>
        {node.issue ? <Badge status={node.issue.state} /> : <span>External</span>}
      </div>
      <small className="dependency-node-title">
        {node.issue?.title ?? "Outside current issue filters"}
      </small>
      <div className="dependency-node-meta">
        {node.blockedByCount > 0 ? <span>Blocked by {node.blockedByCount}</span> : null}
        {node.blocksCount > 0 ? <span>Blocks {node.blocksCount}</span> : null}
        {node.blockedByCount === 0 && node.blocksCount === 0 ? (
          <span>No blockers</span>
        ) : null}
      </div>
    </article>
  );
}

function buildDependencyGraph(issues: IssueRow[]): DependencyGraph {
  const issueByIdentifier = new Map<string, IssueRow>();
  const order = new Map<string, number>();
  const blockersByIssue = new Map<string, string[]>();

  issues.forEach((issue, index) => {
    issueByIdentifier.set(issue.identifier, issue);
    order.set(issue.identifier, index);
    blockersByIssue.set(issue.identifier, []);
  });

  const edgeMap = new Map<string, DependencyEdge>();
  let nextOrder = issues.length;

  for (const issue of issues) {
    const blockers = uniqueIdentifiers(parseIssueStringList(issue.blockers)).filter(
      (identifier) => identifier !== issue.identifier,
    );
    blockersByIssue.set(issue.identifier, blockers);
    for (const blocker of blockers) {
      if (!order.has(blocker)) {
        order.set(blocker, nextOrder);
        nextOrder += 1;
      }
      edgeMap.set(`${blocker}\u0000${issue.identifier}`, {
        from: blocker,
        to: issue.identifier,
        external: !issueByIdentifier.has(blocker),
      });
    }
  }

  const edges = Array.from(edgeMap.values());
  const blocksCount = new Map<string, number>();
  const blockedByCount = new Map<string, number>();
  for (const edge of edges) {
    blocksCount.set(edge.from, (blocksCount.get(edge.from) ?? 0) + 1);
    blockedByCount.set(edge.to, (blockedByCount.get(edge.to) ?? 0) + 1);
  }

  const identifiers = new Set<string>([
    ...issues.map((issue) => issue.identifier),
    ...edges.flatMap((edge) => [edge.from, edge.to]),
  ]);
  const layerCache = new Map<string, number>();
  const visiting = new Set<string>();

  const layerFor = (identifier: string): number => {
    const cached = layerCache.get(identifier);
    if (cached !== undefined) return cached;
    if (visiting.has(identifier)) return 0;

    visiting.add(identifier);
    const upstream = blockersByIssue.get(identifier) ?? [];
    const layer =
      upstream.length === 0
        ? 0
        : Math.max(...upstream.map((blocker) => layerFor(blocker) + 1));
    visiting.delete(identifier);
    layerCache.set(identifier, layer);
    return layer;
  };

  const layered = Array.from(identifiers, (identifier) => ({
    identifier,
    issue: issueByIdentifier.get(identifier) ?? null,
    external: !issueByIdentifier.has(identifier),
    layer: layerFor(identifier),
    row: 0,
    x: 0,
    y: 0,
    blocksCount: blocksCount.get(identifier) ?? 0,
    blockedByCount: blockedByCount.get(identifier) ?? 0,
  }));

  const layers = new Map<number, DependencyNode[]>();
  for (const node of layered) {
    const nodes = layers.get(node.layer) ?? [];
    nodes.push(node);
    layers.set(node.layer, nodes);
  }

  const positioned: DependencyNode[] = [];
  for (const [layer, nodes] of layers) {
    nodes.sort((a, b) => {
      if (a.external !== b.external) return a.external ? -1 : 1;
      return (order.get(a.identifier) ?? 0) - (order.get(b.identifier) ?? 0);
    });
    nodes.forEach((node, row) => {
      positioned.push({
        ...node,
        row,
        x: DEPENDENCY_PADDING + layer * (DEPENDENCY_NODE_WIDTH + DEPENDENCY_LAYER_GAP),
        y: DEPENDENCY_PADDING + row * (DEPENDENCY_NODE_HEIGHT + DEPENDENCY_ROW_GAP),
      });
    });
  }

  const maxLayer = Math.max(0, ...positioned.map((node) => node.layer));
  const maxRows = Math.max(
    1,
    ...Array.from(layers.values(), (nodes) => Math.max(1, nodes.length)),
  );

  return {
    nodes: positioned.sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return a.row - b.row;
    }),
    edges: edges.sort(
      (a, b) =>
        (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0) ||
        (order.get(a.to) ?? 0) - (order.get(b.to) ?? 0),
    ),
    width:
      DEPENDENCY_PADDING * 2 +
      (maxLayer + 1) * DEPENDENCY_NODE_WIDTH +
      maxLayer * DEPENDENCY_LAYER_GAP,
    height:
      DEPENDENCY_PADDING * 2 +
      maxRows * DEPENDENCY_NODE_HEIGHT +
      Math.max(0, maxRows - 1) * DEPENDENCY_ROW_GAP,
    issueCount: issues.length,
    blockedIssueCount: issues.filter((issue) => (blockedByCount.get(issue.identifier) ?? 0) > 0)
      .length,
    externalBlockerCount: positioned.filter((node) => node.external).length,
  };
}

function parseIssueStringList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function uniqueIdentifiers(identifiers: string[]): string[] {
  return Array.from(new Set(identifiers));
}

function Empty({
  title,
  text,
  actionLabel,
  actionDisabled,
  onAction,
}: {
  title: string;
  text?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {text ? <span>{text}</span> : null}
      {actionLabel ? (
        <button disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function Badge({ status }: { status: string }) {
  return <span className={`badge ${statusSlug(status)}`}>{status}</span>;
}


export default function DependencyGraphScreen({ issues }: { issues: IssueRow[] }) {
  return <DependencyGraphView graph={buildDependencyGraph(issues)} />;
}
