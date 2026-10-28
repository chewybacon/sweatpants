import type { Operation, Outcome, Work } from "@standard-durability/core";
import type { Guest, LogicalScope, ScopeInstruction, Turn } from "./contracts.ts";

type Instruction =
  | { kind: "ensure"; owner: Frame; work: Work<void, unknown> }
  | { kind: "critical"; owner: Frame; work: Work<unknown, unknown> }
  | { kind: "scoped"; owner: Frame; work: (scope: LogicalScope) => Operation<unknown, unknown> };

type Step = Outcome<unknown, unknown>;
interface Frame {
  id: string;
  scopeId: string;
  scope: LogicalScope;
  iterator: Iterator<unknown, unknown, unknown>;
  mode: "body" | "cleanup";
  critical: boolean;
  cleanup: Work<void, unknown>[];
  cleanupIndex: number;
  children: number;
  result?: Step;
  failures: unknown[];
}

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
  const instructions = new WeakMap<object, Instruction>();
  const stack: Frame[] = [];
  let cleanupFrames = 0;
  const criticalRegions: string[] = [];
  let state: "new" | "running" | "suspended" | "terminal" | "closed" = "new";
  let cancellation: string | undefined;
  let boundary: Turn<R, Request> | undefined;

  function instruction(value: Instruction): ScopeInstruction {
    // Opaque controls are local to this evaluator, never serialized or delivered.
    const token = {} as ScopeInstruction;
    instructions.set(token, value);
    return token;
  }
  function frame(
    id: string,
    body: (scope: LogicalScope) => Operation<unknown, unknown>,
    owner?: Frame,
  ): Frame {
    const scope: LogicalScope = owner?.scope ?? {
      *ensure(cleanup) {
        yield instruction({ kind: "ensure", owner: current, work: cleanup });
      },
      *critical<T, Y>(region: Work<T, Y>) {
        return (yield instruction({ kind: "critical", owner: current, work: region })) as T;
      },
      *scoped<T, Y>(child: (scope: LogicalScope) => Operation<T, Y>) {
        // Iterator reply is erased only inside the interpreter; this control owns T.
        return (yield instruction({ kind: "scoped", owner: current, work: child })) as T;
      },
    };
    const current: Frame = {
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
        return yield* body(scope);
      })(),
    };
    return current;
  }
  function protectedCleanup(): boolean {
    return cleanupFrames > 0;
  }
  function cancellationDeferred(): boolean {
    return protectedCleanup() || criticalRegions.length > 0;
  }
  function nextCleanup(current: Frame): boolean {
    const cleanup = current.cleanup.pop();
    if (!cleanup) {
      return false;
    }
    if (current.mode === "body") {
      cleanupFrames++;
    }
    current.mode = "cleanup";
    current.cleanupIndex = current.cleanup.length;
    current.iterator = (function* () {
      yield* cleanup();
    })();
    return true;
  }
  function failure(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  function advance(reply: Step): Turn<R, Request> {
    state = "running";
    while (stack.length) {
      const current = stack[stack.length - 1]!;
      if (cancellation !== undefined && !cancellationDeferred()) {
        // Registered cleanup owns exit; never return() through an opaque body iterator.
        if (!reply.ok) {
          current.failures.push(reply.error);
        }
      } else {
        try {
          const next = reply.ok
            ? current.iterator.next(reply.value)
            : current.iterator.throw
              ? current.iterator.throw(reply.error)
              : (() => {
                  throw reply.error;
                })();
          reply = { ok: true, value: undefined };
          if (!next.done) {
            const value = next.value;
            const control =
              typeof value === "object" && value !== null ? instructions.get(value) : undefined;
            if (control) {
              if (control.owner.scope !== current.scope) {
                throw new Error("Logical scope used outside its owner");
              }
              if (control.kind === "ensure") {
                if (control.owner.mode !== "body") {
                  throw new Error("Register nested cleanup in a nested scope");
                }
                control.owner.cleanup.push(control.work);
              } else {
                const id = `${current.id}/${current.mode}:${current.cleanupIndex}/${current.children++}`;
                if (control.kind === "critical") {
                  criticalRegions.push(id);
                  stack.push(frame(id, control.work, current));
                } else {
                  stack.push(frame(id, control.work));
                }
              }
              continue;
            }
            state = "suspended";
            return (boundary = {
              kind: "suspended",
              request: value as Request,
              scope: {
                scopeId: current.scopeId,
                frameId: `${current.id}/${current.mode}:${current.cleanupIndex}`,
                phase: protectedCleanup() ? "cleanup" : "body",
                critical: criticalRegions[0],
              },
            });
          }
          if (current.mode === "body") {
            current.result = { ok: true, value: next.value };
          }
        } catch (error) {
          if (current.mode === "body") {
            current.result = { ok: false, error };
          } else {
            current.failures.push(error);
          }
        }
      }
      if (nextCleanup(current)) {
        reply = { ok: true, value: undefined };
        continue;
      }
      stack.pop();
      if (current.critical) {
        criticalRegions.pop();
      }
      if (current.mode === "cleanup") {
        cleanupFrames--;
      }
      const errors = [
        ...(current.result && !current.result.ok ? [current.result.error] : []),
        ...current.failures,
      ];
      reply = errors.length
        ? {
            ok: false,
            error:
              errors.length === 1
                ? errors[0]
                : new AggregateError(errors, errors.map(failure).join("\n")),
          }
        : (current.result ?? { ok: true, value: undefined });
    }
    state = "terminal";
    if (cancellation !== undefined) {
      return (boundary = {
        kind: "cancelled",
        reason: cancellation,
        failure: reply.ok ? undefined : failure(reply.error),
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
      stack.push(frame("root", work));
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
      if (cancellationDeferred()) {
        return boundary!;
      }
      return advance({ ok: true, value: undefined });
    },
    *close() {
      if (state === "running") {
        throw new Error("Cannot close an advancing scope");
      }
      stack.length = 0;
      cleanupFrames = 0;
      criticalRegions.length = 0;
      boundary = undefined;
      state = "closed";
    },
  };
}
