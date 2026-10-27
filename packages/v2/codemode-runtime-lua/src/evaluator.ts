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
    let phase: "new" | "busy" | "suspended" | "completed" | "failed" | "closed" = "new";
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
          turn = { kind: "suspended", request: options.decodeRequest(boundary.request) };
          phase = "suspended";
        } else if (boundary.kind === "completed") {
          turn = { kind: "completed", value: options.decodeResult(boundary.value) };
          phase = "completed";
        } else if (boundary.kind === "failed") {
          throw new LuaFailure(boundary.error);
        } else {
          throw new Error("Unexpected Lua boundary");
        }
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
      *close() {
        if (phase === "busy") {
          throw new Error("Cannot close Lua guest during advancement");
        }
        state = undefined;
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
