import type { Operation, Outcome, Work } from "@standard-durability/core";
import type { LogicalScope, ScopeInstruction } from "./contracts.ts";
import type { ScopeControl, ScopeFrame } from "./types.ts";

/** A critical frame shares its owner's scope; an ordinary frame owns a new scope. */
export function createScopeFrame(
  id: string,
  work: (scope: LogicalScope) => Operation<unknown, unknown>,
  instruction: (control: ScopeControl) => ScopeInstruction,
  owner?: ScopeFrame,
): ScopeFrame {
  const scope: LogicalScope = owner?.scope ?? {
    *ensure(cleanup) {
      yield instruction({ kind: "ensure", owner: current, work: cleanup });
    },
    *critical<R, Q>(region: Work<R, Q>) {
      return (yield instruction({ kind: "critical", owner: current, work: region })) as R;
    },
    *scoped<R, Q>(child: (scope: LogicalScope) => Operation<R, Q>) {
      // Correlation is erased only inside the evaluator; this instruction owns R.
      return (yield instruction({ kind: "scoped", owner: current, work: child })) as R;
    },
  };
  const current: ScopeFrame = {
    id,
    scopeId: owner?.scopeId ?? id,
    mode: "body",
    critical: owner !== undefined,
    cleanup: [],
    cleanupIndex: -1,
    children: 0,
    failures: [],
    scope,
    iterator: (function* () {
      return yield* work(scope);
    })(),
  };
  return current;
}

/** Body exit is provisional until all registered cleanup has drained. */
export function recordScopeExit(frame: ScopeFrame, outcome: Outcome<unknown, unknown>): void {
  if (frame.mode === "body") {
    frame.result = outcome;
  } else if (!outcome.ok) {
    frame.failures.push(outcome.error);
  }
}

/** Abandon the body without return/throw; retain a failure arriving from a drained child. */
export function abandonScopeBody(frame: ScopeFrame, reply: Outcome<unknown, unknown>): void {
  if (!reply.ok) {
    frame.failures.push(reply.error);
  }
}

/** Select the next registered cleanup in LIFO order without advancing it. */
export function beginScopeCleanup(frame: ScopeFrame): boolean {
  const cleanup = frame.cleanup.pop();
  if (!cleanup) {
    return false;
  }
  frame.mode = "cleanup";
  frame.cleanupIndex = frame.cleanup.length;
  frame.iterator = (function* () {
    yield* cleanup();
  })();
  return true;
}

export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Called only after cleanup drains; body failure precedes cleanup failures. */
export function settleScopeFrame(frame: ScopeFrame): Outcome<unknown, unknown> {
  const errors = [
    ...(frame.result && !frame.result.ok ? [frame.result.error] : []),
    ...frame.failures,
  ];
  if (!errors.length) {
    return frame.result ?? { ok: true, value: undefined };
  }
  return {
    ok: false,
    error:
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, errors.map(describeFailure).join("\n")),
  };
}
