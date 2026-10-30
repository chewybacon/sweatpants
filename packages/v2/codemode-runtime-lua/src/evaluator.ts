import type { Operation, Outcome } from "@standard-durability/core";
import type { Guest, Turn } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { LuaEvaluator } from "./contracts.ts";
import { invoke, record } from "./wasm.ts";

/** Authored failure data stays distinguishable from transport/decoder failures. */
export class LuaFailure extends Error {
  constructor(readonly value: unknown) {
    super("Lua workflow failed");
    this.name = "LuaFailure";
  }
}

/**
 * Bind the pinned Lua VM to Guest execution, logical cancellation and checkpoints.
 * workflow.scope cleanup is protected; physical close only discards VM state.
 */
export function createLuaEvaluator<R, Q, Y>(
  runtime: Runtime<Y>,
  options: {
    readonly source: string;
    readonly input: unknown;
    readonly loadModule: () => Promise<WebAssembly.Module>;
    readonly decodeRequest: (value: unknown) => Q;
    readonly decodeResult: (value: unknown) => R;
  },
): LuaEvaluator<R, Q, Y> {
  const owned = new WeakMap<Guest<R, Q, Y>, () => unknown>();
  function create() {
    let state: Record<string, unknown> | undefined;
    let phase: "new" | "busy" | "suspended" | "completed" | "cancelled" | "failed" | "closed" =
      "new";
    let current: Turn<R, Q> | undefined;
    function* transition(
      action: string,
      fields: Record<string, unknown>,
    ): Operation<Turn<R, Q>, Y> {
      phase = "busy";
      let finished = false;
      try {
        const module = yield* runtime.fromPromise(() => options.loadModule());
        let result = invoke(module, { source: options.source, action, ...fields });
        while (record(result.boundary).kind === "compute_paused") {
          if (typeof result.fuel_used !== "number" || result.fuel_used >= 20_000_000) {
            throw new Error("Lua computation budget exceeded");
          }
          result = invoke(module, { source: options.source, action: "continue", state: result });
        }
        const boundary = record(result.boundary);
        let turn: Turn<R, Q>;
        if (boundary.kind === "suspended") {
          const cleanup = typeof result.cleanup_depth === "number" && result.cleanup_depth > 0;
          if (result.cancelling === true && !cleanup) {
            throw new Error("Lua yielded outside cleanup during cancellation");
          }
          turn = {
            kind: "suspended",
            request: options.decodeRequest(boundary.request),
            scope: {
              scopeId: "lua:root",
              frameId: cleanup ? `lua:cleanup:${result.cleanup_depth}` : "lua:body",
              phase: cleanup ? "cleanup" : "body",
            },
          };
          phase = "suspended";
        } else if (boundary.kind === "completed") {
          turn = { kind: "completed", value: options.decodeResult(boundary.value) };
          phase = "completed";
        } else if (
          boundary.kind === "cancelled" ||
          (boundary.kind === "failed" && result.cancelling === true)
        ) {
          if (typeof result.reason !== "string") {
            throw new Error("Missing Lua cancellation reason");
          }
          turn = {
            kind: "cancelled",
            reason: result.reason,
            failure:
              boundary.kind === "failed"
                ? typeof boundary.error === "string"
                  ? boundary.error
                  : JSON.stringify(boundary.error)
                : undefined,
          };
          phase = "cancelled";
        } else if (boundary.kind === "failed") {
          throw new LuaFailure(boundary.error);
        } else {
          throw new Error("Unexpected Lua boundary");
        }
        current = turn;
        state = result;
        finished = true;
        return turn;
      } finally {
        if (!finished) {
          phase = "failed";
          state = undefined;
        }
      }
    }
    const guest: Guest<R, Q, Y> = {
      *start() {
        if (phase !== "new") {
          throw new Error(`Cannot start Lua guest while ${phase}`);
        }
        return yield* transition("start", { input: options.input });
      },
      *resume(outcome: Outcome<unknown, unknown>) {
        if (phase !== "suspended") {
          throw new Error(`Cannot resume Lua guest while ${phase}`);
        }
        return yield* transition(outcome.ok ? "resume" : "reject", {
          state,
          reply: outcome.ok ? outcome.value : outcome.error,
        });
      },
      *cancel(reason) {
        if (phase === "cancelled" || (phase === "suspended" && state?.cancelling === true)) {
          return current!;
        }
        if (phase !== "suspended") {
          throw new Error(`Cannot cancel Lua guest while ${phase}`);
        }
        return yield* transition("cancel", { state, reason });
      },
      *close() {
        if (phase === "busy") {
          throw new Error("Cannot close Lua guest during advancement");
        }
        state = undefined;
        current = undefined;
        phase = "closed";
      },
    };
    owned.set(guest, () => {
      if (phase !== "suspended" || !state) {
        throw new Error("Lua checkpoint requires a suspended boundary");
      }
      return structuredClone(state);
    });
    return { guest, transition };
  }
  return {
    *acquire() {
      return create().guest;
    },
    checkpoints: {
      format: "piccolo-continuation-4",
      *capture(guest) {
        return owned.get(guest)?.();
      },
      *restore(snapshot) {
        const { guest, transition } = create();
        let restored = false;
        try {
          const turn = yield* transition("restore", { state: record(structuredClone(snapshot)) });
          restored = true;
          return { guest, turn };
        } finally {
          if (!restored) {
            yield* guest.close();
          }
        }
      },
    },
  };
}
