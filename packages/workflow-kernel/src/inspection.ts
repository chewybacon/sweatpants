import type { WorkflowBoundary } from "./index.ts";

/** A detached observation, never a checkpoint or authority to resume execution. */
export interface ExecutionInspection {
  readonly availability: {
    readonly calls: "available" | "unavailable";
    readonly environments: "available" | "unavailable";
    readonly unwind: "available" | "unavailable";
  };
  /** Live suspension IDs are deliberately excluded: they can change on restore. */
  readonly boundary: InspectedBoundary;
  /** Outermost caller first. IDs are local to this inspection. */
  readonly calls: readonly InspectedCall[];
  /** Lexical ancestry, not call or cleanup ownership. */
  readonly environments: readonly InspectedEnvironment[];
  /** Innermost continuation first; scope and finally unwinding remain distinct. */
  readonly unwind: readonly InspectedUnwind[];
  /** At least one collection or displayed value was shortened. */
  readonly truncated: boolean;
}

export type InspectedBoundary =
  | Omit<Extract<WorkflowBoundary, { kind: "suspended" }>, "suspensionId">
  | Exclude<WorkflowBoundary, { kind: "suspended" }>;

export interface InspectedCall {
  readonly id: string;
  readonly name: string;
}

/** Display-only values do not claim to preserve heap identity or support restore. */
export type InspectedValue =
  | { readonly kind: "display"; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "closure"; readonly name: string; readonly environmentId: string }
  | { readonly kind: "callable"; readonly name: string };

export interface InspectedBinding {
  readonly name: string;
  readonly value: InspectedValue;
}

export interface InspectedEnvironment {
  readonly id: string;
  readonly parentId: string | null;
  readonly bindings: readonly InspectedBinding[];
}

export type PendingCompletion =
  | { readonly kind: "normal" | "return" | "throw"; readonly value: InspectedValue }
  | { readonly kind: "break" | "continue" | "cancel" };

export type InspectedUnwind =
  | {
      readonly kind: "scope";
      readonly label: string;
      readonly pendingCleanup: readonly InspectedValue[];
    }
  | {
      readonly kind: "cleanup";
      /** Excludes the cleanup currently executing, which appears in the call stack. */
      readonly remaining: readonly InspectedValue[];
      readonly completion: PendingCompletion;
    }
  | { readonly kind: "finally"; readonly completion: PendingCompletion };
