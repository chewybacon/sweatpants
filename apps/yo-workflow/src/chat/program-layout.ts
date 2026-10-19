import { graphlib, layout as layoutGraph } from "@dagrejs/dagre";
import { MarkerType, type Node, type Edge } from "@xyflow/react";
import type { FlowNode } from "./flow.ts";
import type { createSchemeFlow } from "./scheme-flow.ts";

export type Flow = ReturnType<typeof createSchemeFlow>;

export type ProgramNode = Node<{ step: FlowNode }, "program">;
export type LoopNode = Node<{ label: string }, "loop">;
export type CanvasNode = ProgramNode | LoopNode;
export const nodeLabels = {
  yield: "Yield",
  branch: "Branch",
  call: "Operation",
  exit: "Completion",
  entry: "Start",
};

export type Point = { x: number; y: number };
export type RoutedEdge = Edge<{ points: Point[]; labelX?: number; labelY?: number }, "routed">;

export function layoutFlow(flow: Flow) {
  const source = new graphlib.Graph();
  const steps = new Map(flow.nodes.map((n) => [n.id, n]));
  flow.nodes.forEach((n) => source.setNode(n.id));
  flow.edges.forEach((e) => source.setEdge(e.source, e.target));
  const loops = graphlib.alg.tarjan(source).filter((members) => {
    const ids = new Set(members);
    const cyclic = members.length > 1 || source.hasEdge(members[0], members[0]);
    const entrances = new Set(
      flow.edges.filter((e) => !ids.has(e.source) && ids.has(e.target)).map((e) => e.target),
    );
    return cyclic && entrances.size === 1;
  });
  const returns = new Map<number, { region: string; lane: number }>();
  loops.forEach((members, i) => {
    const ids = new Set(members);
    const header = flow.edges.find((e) => !ids.has(e.source) && ids.has(e.target))!.target;
    let lane = 0;
    flow.edges.forEach((e, index) => {
      if (ids.has(e.source) && e.target === header) {
        returns.set(index, { region: `loop-region-${i}`, lane: lane++ });
      }
    });
  });
  const regionOf = new Map<string, string>();
  loops.forEach((members, i) => members.forEach((id) => regionOf.set(id, `loop-region-${i}`)));

  // Consecutive branch checks form a vertical column. The outer layout sees
  // that entire column as one block, so ordinary steps still advance right.
  // Forks, joins and cycles within the branch subgraph keep their own blocks.
  const nextBranch = (id: string) =>
    flow.edges.filter(
      (e) =>
        e.source === id &&
        steps.get(e.target)?.kind === "branch" &&
        regionOf.get(id) === regionOf.get(e.target),
    );
  const previousBranch = (id: string) =>
    flow.edges.filter(
      (e) =>
        e.target === id &&
        steps.get(e.source)?.kind === "branch" &&
        regionOf.get(id) === regionOf.get(e.source),
    );
  const blockOf = new Map(flow.nodes.map((n) => [n.id, n.id]));
  const columns = new Map<string, string[]>();
  for (const step of flow.nodes) {
    if (step.kind !== "branch" || previousBranch(step.id).length !== 0) {
      continue;
    }
    const members = [step.id];
    let next = nextBranch(step.id);
    while (
      next.length === 1 &&
      previousBranch(next[0].target).length === 1 &&
      !members.includes(next[0].target)
    ) {
      members.push(next[0].target);
      next = nextBranch(next[0].target);
    }
    if (members.length < 2) {
      continue;
    }
    const id = `branch-column-${columns.size}`;
    columns.set(id, members);
    members.forEach((member) => blockOf.set(member, id));
  }
  const layout = new graphlib.Graph({ multigraph: true, compound: true });
  layout.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 64, marginx: 28, marginy: 28 });
  layout.setDefaultEdgeLabel(() => ({}));
  const size = (n: FlowNode) =>
    n.kind === "yield"
      ? { width: 232, height: 124 }
      : n.kind === "entry" || n.kind === "exit"
        ? { width: 112, height: 48 }
        : { width: 184, height: 88 };
  flow.nodes.forEach((n) => {
    if (blockOf.get(n.id) === n.id) {
      layout.setNode(n.id, size(n));
    }
  });
  columns.forEach((members, id) =>
    layout.setNode(id, { width: 264, height: members.length * 88 + (members.length - 1) * 56 }),
  );
  loops.forEach((members, i) => {
    const id = `loop-region-${i}`;
    layout.setNode(id, {});
    members.forEach((member) => layout.setParent(blockOf.get(member)!, id));
  });
  flow.edges.forEach((e, i) => {
    if (returns.has(i)) {
      return;
    }
    const from = blockOf.get(e.source)!,
      to = blockOf.get(e.target)!;
    if (from === to && columns.has(from)) {
      return;
    }
    layout.setEdge(
      from,
      to,
      {
        width: e.label ? Math.min(65, e.label.length) * 6 + 16 : 0,
        height: e.label ? 24 : 0,
        labelpos: "c",
        weight:
          steps.get(e.source)?.kind === "yield" && steps.get(e.target)?.kind === "yield" ? 8 : 1,
      },
      String(i),
    );
  });
  layoutGraph(layout);
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const nodes: ProgramNode[] = flow.nodes.map((step) => {
    const block = blockOf.get(step.id)!,
      p = layout.node(block);
    const dimensions = size(step);
    const members = columns.get(block);
    const centerY = members ? p.y - p.height / 2 + members.indexOf(step.id) * 144 + 44 : p.y;
    boxes.set(step.id, { x: p.x, y: centerY, ...dimensions });
    return {
      id: step.id,
      type: "program",
      data: { step },
      position: { x: p.x - dimensions.width / 2, y: centerY - dimensions.height / 2 },
      ...dimensions,
      ariaLabel: [
        step.origin === "builtin"
          ? "Built-in"
          : step.origin === "authored"
            ? "Authored tool"
            : nodeLabels[step.kind],
        step.title,
      ].join(": "),
    };
  });
  // Align straight sequences independently of the branch-column height.
  const seen = new Set<string>();
  for (const step of flow.nodes) {
    if (step.kind !== "yield" || seen.has(step.id)) {
      continue;
    }
    const chain = [step.id];
    let current = step.id;
    while (true) {
      const next = flow.edges.filter(
        (e, i) =>
          e.source === current &&
          !returns.has(i) &&
          steps.get(e.target)?.kind === "yield" &&
          regionOf.get(current) === regionOf.get(e.target),
      );
      if (next.length !== 1 || chain.includes(next[0].target)) {
        break;
      }
      current = next[0].target;
      chain.push(current);
    }
    const row = Math.max(...chain.map((id) => boxes.get(id)!.y));
    chain.forEach((id) => {
      boxes.get(id)!.y = row;
      seen.add(id);
    });
  }
  columns.forEach((members) => {
    const incoming = flow.edges.filter(
      (e, i) => e.target === members[0] && !members.includes(e.source) && !returns.has(i),
    );
    if (!incoming.length) {
      return;
    }
    const row = Math.max(...incoming.map((e) => boxes.get(e.source)!.y));
    members.forEach((id, i) => {
      boxes.get(id)!.y = row + i * 144;
    });
  });
  for (const step of flow.nodes) {
    if (step.kind !== "entry") {
      continue;
    }
    const next = flow.edges.filter((e) => e.source === step.id);
    if (next.length === 1) {
      boxes.get(step.id)!.y = boxes.get(next[0].target)!.y;
    }
  }
  const bodyBottom = Math.max(
    ...flow.nodes
      .filter((n) => n.kind !== "exit")
      .map((n) => {
        const b = boxes.get(n.id)!;
        return b.y + b.height / 2;
      }),
  );
  flow.nodes
    .filter((n) => n.kind === "exit" && n.title === "Fail")
    .forEach((n) => {
      boxes.get(n.id)!.y = bodyBottom + 100;
    });
  nodes.forEach((n) => {
    const b = boxes.get(n.id)!;
    n.position = { x: b.x - b.width / 2, y: b.y - b.height / 2 };
  });
  const bodyTop = Math.min(...[...boxes.values()].map((b) => b.y - b.height / 2));
  let bypassLane = 0;
  const intersectsNode = (points: Point[], sourceId: string, targetId: string) =>
    [...boxes].some(([id, b]) => {
      if (id === sourceId || id === targetId) {
        return false;
      }
      const left = b.x - b.width / 2 - 8,
        right = b.x + b.width / 2 + 8;
      const top = b.y - b.height / 2 - 8,
        bottom = b.y + b.height / 2 + 8;
      return points.slice(1).some((p, i) => {
        const q = points[i];
        return p.x === q.x
          ? p.x > left && p.x < right && Math.max(p.y, q.y) > top && Math.min(p.y, q.y) < bottom
          : p.y > top && p.y < bottom && Math.max(p.x, q.x) > left && Math.min(p.x, q.x) < right;
      });
    });
  const edges: RoutedEdge[] = flow.edges.map((e, i) => {
    const from = blockOf.get(e.source)!,
      to = blockOf.get(e.target)!;
    const a = boxes.get(e.source)!,
      b = boxes.get(e.target)!;
    const internal = from === to && columns.has(from);
    const repeat = returns.get(i);
    let points: Point[], labelX: number, labelY: number;
    if (repeat) {
      const members = loops[Number(repeat.region.split("-").at(-1))];
      const top = Math.min(
        ...members.map((id) => {
          const box = boxes.get(id)!;
          return box.y - box.height / 2;
        }),
      );
      const laneY = top - 48 - repeat.lane * 28;
      const gutter = a.x - a.width / 2 - 24 - repeat.lane * 6;
      points = [
        { x: a.x - a.width / 2, y: a.y },
        { x: gutter, y: a.y },
        { x: gutter, y: laneY },
        { x: b.x, y: laneY },
        { x: b.x, y: b.y - b.height / 2 },
      ];
      labelX = (gutter + b.x) / 2;
      labelY = laneY;
    } else if (internal) {
      points = [
        { x: a.x, y: a.y + a.height / 2 },
        { x: b.x, y: b.y - b.height / 2 },
      ];
      labelX = a.x;
      labelY = (points[0].y + points[1].y) / 2;
    } else {
      const right = a.x + a.width / 2,
        left = b.x - b.width / 2;
      const middle = (right + left) / 2;
      points = [
        { x: right, y: a.y },
        { x: middle, y: a.y },
        { x: middle, y: b.y },
        { x: left, y: b.y },
      ];
      labelX = middle;
      labelY = (a.y + b.y) / 2;
      if (left <= right || intersectsNode(points, e.source, e.target)) {
        const lane = bodyTop - 180 - bypassLane++ * 32;
        points = [
          { x: right, y: a.y },
          { x: right + 20, y: a.y },
          { x: right + 20, y: lane },
          { x: left - 20, y: lane },
          { x: left - 20, y: b.y },
          { x: left, y: b.y },
        ];
        labelX = (right + left) / 2;
        labelY = lane;
      }
    }
    // Remove coincident waypoints before rounding the route's corners.
    points = points.filter(
      (p, index) => index === 0 || p.x !== points[index - 1].x || p.y !== points[index - 1].y,
    );
    return {
      ...e,
      id: "edge-" + i,
      type: "routed",
      data: { points, labelX, labelY },
      label: e.label && e.label.length > 65 ? e.label.slice(0, 64) + "…" : e.label,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#817c98", width: 14, height: 14 },
      style: {
        stroke: "var(--flow-edge)",
        strokeWidth: 1.5,
        strokeDasharray: repeat ? "5 4" : undefined,
      },
    };
  });
  const regions: LoopNode[] = loops.map((members, i) => {
    const id = `loop-region-${i}`;
    const points = members.flatMap((member) => {
      const b = boxes.get(member)!;
      return [
        { x: b.x - b.width / 2, y: b.y - b.height / 2 },
        { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      ];
    });
    edges.forEach((e) => {
      if (members.includes(e.source) && members.includes(e.target)) {
        points.push(...e.data!.points);
      }
    });
    const left = Math.min(...points.map((p) => p.x)) - 36,
      right = Math.max(...points.map((p) => p.x)) + 36;
    const top = Math.min(...points.map((p) => p.y)) - 44,
      bottom = Math.max(...points.map((p) => p.y)) + 28;
    return {
      id,
      type: "loop",
      data: { label: "Repeat" },
      position: { x: left, y: top },
      width: right - left,
      height: bottom - top,
      zIndex: -1,
      selectable: false,
      draggable: false,
      focusable: false,
      ariaLabel: "Repeating steps",
    };
  });
  return { nodes: [...regions, ...nodes], edges };
}
