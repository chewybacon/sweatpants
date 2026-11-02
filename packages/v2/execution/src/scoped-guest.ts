import type { Operation, Outcome } from "@standard-durability/core";
import type { Guest, LogicalScope, ScopeInstruction, Turn } from "./contracts.ts";

import { abandonScopeBody, describeFailure, recordScopeExit } from "./scope-frame.ts";
import { createScopeStack } from "./scope-stack.ts";

/**
 * Evaluate registered logical scopes behind the ordinary Guest protocol.
 * Cleanup frames are explicit and replay-stable. Cancelling during cleanup preserves
 * its iterator and request; close discards all frames without running logical cleanup.
 * Nested scopes are sequential; no native tasks, parallel children or checkpoint format.
 *
 * @remarks Register durable logical cleanup with {@link LogicalScope.ensure}.
 * Cancellation and host disposal do not run arbitrary finally blocks in discarded
 * body iterators. Ordinary finally behavior on normal return or exception remains
 * unchanged while those iterators advance. Standard JavaScript iterators cannot
 * reveal whether a suspension is inside finally; preserving arbitrary finally across
 * cancellation requires instrumentation, compilation or another evaluator capability.
 * Registered cleanup already running is protected from repeated logical cancellation.
 */
export function createScopedGuest<R, Q>(
  work: (scope: LogicalScope) => Operation<R, Q>,
): Guest<R, Exclude<Q, ScopeInstruction>, never> {
  type Request = Exclude<Q, ScopeInstruction>;
  const stack = createScopeStack();
  let state: "new" | "running" | "suspended" | "terminal" | "closed" = "new";
  let cancellation: string | undefined;
  let boundary: Turn<R, Request> | undefined;

  function advance(reply: Outcome<unknown, unknown>): Turn<R, Request> {
    state = "running";
    while (stack.current) {
      const current = stack.current;
      if (cancellation !== undefined && !stack.cancellationDeferred) {
        abandonScopeBody(current, reply);
      } else {
        const next = stack.step(reply);
        reply = { ok: true, value: undefined };
        if (!next) {
          continue;
        }
        if (!next.done) {
          state = "suspended";
          return (boundary = {
            kind: "suspended",
            request: next.value as Request,
            scope: stack.boundary(),
          });
        }
        recordScopeExit(current, next.value);
      }
      reply = stack.continueExit();
    }
    state = "terminal";
    if (cancellation !== undefined) {
      return (boundary = {
        kind: "cancelled",
        reason: cancellation,
        failure: reply.ok ? undefined : describeFailure(reply.error),
      });
    }
    if (!reply.ok) {
      throw reply.error;
    }
    return (boundary = { kind: "completed", value: reply.value as R });
  }
  return {
    *start() {
      if (state !== "new") {
        throw new Error(`Cannot start guest while ${state}`);
      }
      stack.enter(work);
      return advance({ ok: true, value: undefined });
    },
    *resume(outcome) {
      if (state !== "suspended") {
        throw new Error(`Cannot resume guest while ${state}`);
      }
      return advance(outcome);
    },
    *cancel(reason) {
      if (state !== "suspended" && state !== "terminal") {
        throw new Error(`Cannot cancel guest while ${state}`);
      }
      if (cancellation !== undefined && boundary) {
        return boundary;
      }
      if (state === "terminal") {
        throw new Error("Cannot cancel a settled scope");
      }
      cancellation = reason;
      if (stack.cancellationDeferred) {
        return boundary!;
      }
      return advance({ ok: true, value: undefined });
    },
    *close() {
      if (state === "running") {
        throw new Error("Cannot close an advancing scope");
      }
      stack.discard();
      boundary = undefined;
      state = "closed";
    },
  };
}
