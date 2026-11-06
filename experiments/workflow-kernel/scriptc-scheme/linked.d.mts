import type { WorkflowModule } from "../../../packages/v2/codemode-compiler/src/index.ts";
export interface LinkedReview {
  readonly source: string;
  readonly program: string;
  readonly identity: string;
  readonly name: string;
  readonly entry: string;
  readonly effects: WorkflowModule["effects"];
}
export function linkReview(input: {
  module: WorkflowModule;
  caller: string;
  name?: string;
  identity: string;
}): LinkedReview;
/** Bound when captured or taken directly from the journal checkpoint envelope. */
export interface LinkedCapture {
  readonly program: string;
  readonly state: unknown;
}
export function inspectLinkedCheckpoint(
  artifact: LinkedReview,
  capture: LinkedCapture,
): {
  site: string;
  effect: string;
  key: string;
  source: { id: string; line: number; column?: number };
  calls: { name: string; kind: "compiled" | "caller" }[];
  cleanup: { kind: string; completion: string }[];
  environments: {
    id: number;
    parent: number | false;
    bindings: { name: string; value: string }[];
  }[];
  steps: number;
  cancellationRequested: boolean;
  truncated: boolean;
};

export function admitLinkedCaller(caller: string): string;
