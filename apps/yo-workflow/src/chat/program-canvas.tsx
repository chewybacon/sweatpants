import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  BaseEdge,
  type ReactFlowInstance,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import type { FlowNode } from "./flow.ts";
import {
  layoutFlow,
  nodeLabels,
  type Flow,
  type ProgramNode,
  type LoopNode,
  type CanvasNode,
  type RoutedEdge,
} from "./program-layout.ts";
function NodeSymbol({ step }: { step: FlowNode }) {
  if (step.origin === "builtin" && step.title === "Random") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <g fill="currentColor" stroke="none">
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="16" cy="8" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="8" cy="16" r="1.5" />
          <circle cx="16" cy="16" r="1.5" />
        </g>
      </svg>
    );
  }
  const path =
    step.origin === "builtin"
      ? "M12 3 5 13h6l-1 8 9-12h-7l1-6"
      : step.origin === "authored"
        ? "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"
        : step.kind === "branch"
          ? "m12 3 9 9-9 9-9-9 9-9"
          : step.kind === "entry"
            ? "m8 5 11 7-11 7V5"
            : step.kind === "exit"
              ? "M6 6h12v12H6z"
              : "M8 5H5v14h3m8-14h3v14h-3";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
function ProgramCard({ data }: NodeProps<ProgramNode>) {
  const { step } = data;
  const failed = step.kind === "exit" && step.title === "Fail";
  const tone = failed ? "failure" : (step.origin ?? step.kind);
  const label =
    step.origin === "builtin"
      ? "Built-in"
      : step.origin === "authored"
        ? "Authored tool"
        : failed
          ? "Failure"
          : nodeLabels[step.kind];
  return (
    <div
      className={"canvas-card canvas-" + step.kind + " canvas-tone-" + tone}
      title={step.detail || step.title}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="canvas-card-heading">
        <span className="canvas-symbol">
          <NodeSymbol step={step} />
        </span>
        <small>{label}</small>
        {step.kind === "yield" && <span className="canvas-boundary">YIELD</span>}
      </div>
      <strong>{step.title}</strong>
      {step.caption && <span className="canvas-caption">{step.caption}</span>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
function LoopRegion({ data }: NodeProps<LoopNode>) {
  return (
    <div className="canvas-loop-region">
      <span>
        <b aria-hidden="true">↻</b> {data.label}
      </span>
    </div>
  );
}
const nodeTypes = { program: ProgramCard, loop: LoopRegion };

// Render the planned route, including branch gutters and loop-return lanes.
function ProgramEdge({ id, data, markerEnd, style, label }: EdgeProps<RoutedEdge>) {
  if (!data?.points.length) {
    return null;
  }
  const points = data.points;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1],
      current = points[i],
      next = points[i + 1];
    const before = Math.hypot(current.x - prev.x, current.y - prev.y);
    const after = Math.hypot(next.x - current.x, next.y - current.y);
    const radius = Math.min(10, before / 2, after / 2);
    if (!before || !after) {
      continue;
    }
    const a = {
      x: current.x + ((prev.x - current.x) * radius) / before,
      y: current.y + ((prev.y - current.y) * radius) / before,
    };
    const b = {
      x: current.x + ((next.x - current.x) * radius) / after,
      y: current.y + ((next.y - current.y) * radius) / after,
    };
    path += ` L ${a.x} ${a.y} Q ${current.x} ${current.y} ${b.x} ${b.y}`;
  }
  const end = points[points.length - 1];
  path += ` L ${end.x} ${end.y}`;
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={data.labelX}
      labelY={data.labelY}
      labelStyle={{ fill: "var(--flow-text)", fontSize: 11 }}
      labelBgStyle={{ fill: "var(--flow-base)" }}
      labelBgPadding={[7, 4]}
      labelBgBorderRadius={4}
    />
  );
}
const edgeTypes = { routed: ProgramEdge };

export function ProgramCanvas({ flow }: { flow: Flow }) {
  const graph = useMemo(() => layoutFlow(flow), [flow]);
  const container = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<CanvasNode> | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element || !instance) {
      return;
    }
    let frame = 0;
    // A canvas mounted inside closed details has no viewport. Fit after it
    // becomes measurable, including when an outer disclosure opens again.
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) {
        return;
      }
      frame = requestAnimationFrame(() => {
        void instance.fitView({ padding: 0.15, maxZoom: 0.85 });
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [instance, graph]);
  return (
    <div ref={container} className="program-canvas" aria-label="Expanded program canvas">
      <div className="canvas-legend" aria-label="Node types">
        <span className="canvas-tone-builtin">
          <i />
          Built-in
        </span>
        <span className="canvas-tone-authored">
          <i />
          Authored tool
        </span>
        <span className="canvas-tone-branch">
          <i />
          Control flow
        </span>
      </div>
      <ReactFlow<CanvasNode>
        onInit={setInstance}
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 0.85 }}
        minZoom={0.03}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        panOnScroll={false}
        preventScrolling={false}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--flow-grid)" gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
