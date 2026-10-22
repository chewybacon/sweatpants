import type { WorkflowBoundary } from "@sweatpants/flowmode-runtime";
import { projectHootInspection } from "./inspection.mts";
import {
  parse,
  symbolName,
  type SchemeDatum,
} from "@sweatpants/flowmode-compiler/scheme-data/read";

type SymbolDatum = { sym: string };
type Frame = [SymbolDatum, ...SchemeDatum[]];
type HootInspectionState = [
  SymbolDatum,
  string,
  [number, number | false, [SymbolDatum, ...SchemeDatum[]][]][],
  number,
  Frame[],
  SymbolDatum,
  SchemeDatum,
  number,
  false | [string, SchemeDatum],
  SymbolDatum,
  number,
  boolean,
];
export interface CleanupInspection {
  kind: string;
  scope: string | null;
  remaining: string[];
  completion: string | null;
}

// Debug projection of evaluator-owned state. Never used to authorize recovery.
function display(value: SchemeDatum | undefined): string {
  if (Array.isArray(value)) {
    if (symbolName(value[0]) === "closure") {
      return `λ ${symbolName(value[4])} → environment ${value[3]}`;
    }
    if (symbolName(value[0]) === "tool") {
      return `registered tool ${symbolName(value[1])}`;
    }
    if (symbolName(value[0]) === "primitive") {
      return `built-in ${symbolName(value[1])}`;
    }
    return `(${value.map(display).join(" ")})`;
  }
  if (value && typeof value === "object" && "sym" in value) {
    return value.sym;
  }
  return JSON.stringify(value) ?? "undefined";
}
export function inspectSnapshot(snapshot: string, boundary: WorkflowBoundary) {
  // This projection consumes the evaluator-owned snapshot layout, not untrusted recovery input.
  const state = parse(snapshot)[0] as HootInspectionState | undefined;
  if (!state || symbolName(state[0]) !== "workflow-state-v3") {
    throw Error("Unknown inspection format");
  }
  const frames = state[4].map((frame, index) => ({
    index,
    kind: frame[0].sym,
    detail: display(frame),
  }));
  return {
    execution: projectHootInspection(state, boundary),
    mode: state[5].sym,
    site: state[8] === false ? null : state[8][0],
    steps: state[10],
    cancellationRequested: state[11],
    snapshotBytes: new TextEncoder().encode(snapshot).length,
    currentEnvironment: state[7],
    calls: state[4]
      .filter((f) => f[0].sym === "call")
      .map((f) => symbolName(f[1]))
      .reverse(),
    frames,
    environments: state[2].map(([id, parent, bindings]) => ({
      id,
      parent: parent === false ? null : parent,
      bindings: bindings.map(([name, ...rest]) => ({
        name: name.sym,
        value: display(symbolName(rest[0]) === "." ? rest[1] : rest),
      })),
    })),
    cleanups: state[4].flatMap<CleanupInspection>((frame) => {
      if (frame[0].sym === "scope") {
        return [
          {
            kind: "registered",
            scope: display(frame[1]),
            remaining: (frame[2] as SchemeDatum[]).map(display),
            completion: null,
          },
        ];
      }
      if (frame[0].sym === "cleanup") {
        return [
          {
            kind: "running",
            scope: null,
            remaining: (frame[1] as SchemeDatum[]).map(display),
            completion: `${display(frame[2])}: ${display(frame[3])}`,
          },
        ];
      }
      if (frame[0].sym === "after-finally") {
        return [
          {
            kind: "finally",
            scope: null,
            remaining: [],
            completion: `${display(frame[1])}: ${display(frame[2])}`,
          },
        ];
      }
      return [];
    }),
  };
}
