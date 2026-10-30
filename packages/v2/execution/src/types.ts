import type { Operation, Outcome, Work } from "@standard-durability/core";
import type { LogicalScope } from "./contracts.ts";

/** A provisional body result and any cleanup failures, local to one live incarnation. */
export interface ScopeFrame {
  id: string;
  scopeId: string;
  scope: LogicalScope;
  iterator: Iterator<unknown, unknown, unknown>;
  mode: "body" | "cleanup";
  critical: boolean;
  cleanup: Work<void, unknown>[];
  cleanupIndex: number;
  children: number;
  result?: Outcome<unknown, unknown>;
  failures: unknown[];
}

/** Evaluator-local instructions; never journal requests or durable authority. */
export type ScopeControl =
  | { kind: "ensure"; owner: ScopeFrame; work: Work<void, unknown> }
  | { kind: "critical"; owner: ScopeFrame; work: Work<unknown, unknown> }
  | {
      kind: "scoped";
      owner: ScopeFrame;
      work: (scope: LogicalScope) => Operation<unknown, unknown>;
    };
