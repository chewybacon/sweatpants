import type { Operation, Outcome } from "@standard-durability/core";
import type { LogicalScope, ScopeBoundary, ScopeInstruction } from "./contracts.ts";
import { stepContinuation } from "./continuation.ts";
import { beginScopeCleanup, createScopeFrame, settleScopeFrame } from "./scope-frame.ts";
import type { ScopeControl, ScopeFrame } from "./types.ts";

/** Owns live frame topology, local instruction recognition and cancellation protection. */
export function createScopeStack() {
  const frames: ScopeFrame[] = [];
  const instructions = new WeakMap<object, ScopeControl>();
  const criticalRegions: string[] = [];
  let cleanupFrames = 0;

  function instruction(control: ScopeControl): ScopeInstruction {
    const token = {} as ScopeInstruction;
    instructions.set(token, control);
    return token;
  }

  function interpret(current: ScopeFrame, control: ScopeControl): void {
    if (control.owner.scope !== current.scope) {
      throw new Error("Logical scope used outside its owner");
    }
    if (control.kind === "ensure") {
      if (control.owner.mode !== "body") {
        throw new Error("Register nested cleanup in a nested scope");
      }
      control.owner.cleanup.push(control.work);
      return;
    }
    const id = `${current.id}/${current.mode}:${current.cleanupIndex}/${current.children++}`;
    if (control.kind === "critical") {
      criticalRegions.push(id);
      frames.push(createScopeFrame(id, control.work, instruction, current));
    } else {
      frames.push(createScopeFrame(id, control.work, instruction));
    }
  }

  return {
    get current(): ScopeFrame | undefined {
      return frames[frames.length - 1];
    },
    get cancellationDeferred(): boolean {
      return cleanupFrames > 0 || criticalRegions.length > 0;
    },
    enter(work: (scope: LogicalScope) => Operation<unknown, unknown>): void {
      frames.push(createScopeFrame("root", work, instruction));
    },
    /** Undefined means a local control was consumed; other yields are domain requests. */
    step(
      reply: Outcome<unknown, unknown>,
    ): IteratorResult<unknown, Outcome<unknown, unknown>> | undefined {
      const current = frames[frames.length - 1]!;
      const next = stepContinuation(current.iterator, reply);
      if (next.done) {
        return next;
      }
      const value = next.value;
      const control =
        typeof value === "object" && value !== null ? instructions.get(value) : undefined;
      if (!control) {
        return next;
      }
      try {
        interpret(current, control);
      } catch (error) {
        return { done: true, value: { ok: false, error } };
      }
      return undefined;
    },
    /** Keep the current frame for cleanup, or settle it into its suspended parent. */
    continueExit(): Outcome<unknown, unknown> {
      const current = frames[frames.length - 1]!;
      const wasBody = current.mode === "body";
      if (beginScopeCleanup(current)) {
        if (wasBody) {
          cleanupFrames++;
        }
        return { ok: true, value: undefined };
      }
      frames.pop();
      if (current.critical) {
        criticalRegions.pop();
      }
      if (current.mode === "cleanup") {
        cleanupFrames--;
      }
      return settleScopeFrame(current);
    },
    boundary(): ScopeBoundary {
      const current = frames[frames.length - 1]!;
      return {
        scopeId: current.scopeId,
        frameId: `${current.id}/${current.mode}:${current.cleanupIndex}`,
        phase: cleanupFrames > 0 ? "cleanup" : "body",
        critical: criticalRegions[0],
      };
    },
    /** Physical disposal drops continuations; it never initiates logical scope exit. */
    discard(): void {
      frames.length = 0;
      cleanupFrames = 0;
      criticalRegions.length = 0;
    },
  };
}
