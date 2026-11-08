import type { Operation } from "@standard-durability/core";
import type { Guest, Turn } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import type {
  SchemeBoundary,
  SchemeEvaluator,
  SchemeMachine,
  SchemeEvaluatorOptions,
} from "./contracts.ts";

export class SchemeFailure extends Error {
  constructor(readonly value: unknown) {
    super("Scheme workflow failed");
    this.name = "SchemeFailure";
  }
}
export function createSchemeEvaluator<R, Q, Y>(
  runtime: Runtime<Y>,
  options: SchemeEvaluatorOptions<R, Q>,
): SchemeEvaluator<R, Q, Y> {
  const owned = new WeakMap<Guest<R, Q, Y>, () => unknown>();
  function create() {
    let machine: SchemeMachine | undefined;
    let phase: "new" | "busy" | "suspended" | "terminal" | "failed" | "closed" = "new";
    let reason: string | undefined;
    let current: Turn<R, Q> | undefined;
    function boundary(value: SchemeBoundary): Turn<R, Q> {
      if (value.kind === "effect") {
        if (reason !== undefined && value.scope.phase !== "cleanup") {
          throw new Error("Scheme yielded outside cleanup during cancellation");
        }
        return { kind: "suspended", request: options.decodeRequest(value), scope: value.scope };
      }
      if (reason !== undefined || value.kind === "cancelled") {
        if (reason === undefined) {
          throw new Error("Scheme cancellation has no host reason");
        }
        return {
          kind: "cancelled",
          reason,
          failure: value.kind === "thrown" ? String(value.value) : undefined,
        };
      }
      if (value.kind === "thrown") {
        throw new SchemeFailure(value.value);
      }
      return { kind: "completed", value: options.decodeResult(value.value) };
    }
    function advance(action: () => SchemeBoundary) {
      phase = "busy";
      try {
        current = boundary(action());
        phase = current.kind === "suspended" ? "suspended" : "terminal";
        return current;
      } catch (error) {
        phase = "failed";
        throw error;
      }
    }
    function check() {
      if (!machine || phase !== "suspended") {
        throw new Error(`Cannot advance Scheme guest while ${phase}`);
      }
      return machine;
    }
    function* initialize(state?: { state: string; reason?: string }): Operation<Turn<R, Q>, Y> {
      if (phase !== "new") {
        throw new Error(`Cannot initialize Scheme guest while ${phase}`);
      }
      phase = "busy";
      let finished = false;
      try {
        machine = yield* runtime.fromPromise((signal) =>
          options.loadMachine().then((loaded) => {
            if (signal.aborted) {
              loaded.close();
              throw new Error("Scheme acquisition cancelled");
            }
            machine = loaded;
            return loaded;
          }),
        );
        reason = state?.reason;
        const turn = advance(() =>
          state
            ? machine!.restore(options.source, state.state)
            : machine!.start(options.source, options.input),
        );
        finished = true;
        return turn;
      } finally {
        if (!finished) {
          machine?.close();
          machine = undefined;
          phase = "failed";
        }
      }
    }
    const guest: Guest<R, Q, Y> = {
      *start() {
        return yield* initialize();
      },
      *resume(outcome) {
        const vm = check();
        return advance(() => (outcome.ok ? vm.resume(outcome.value) : vm.reject(outcome.error)));
      },
      *cancel(requested) {
        if (reason !== undefined && current && (phase === "suspended" || phase === "terminal")) {
          return current;
        }
        const vm = check();
        reason = requested;
        return advance(() => vm.cancel());
      },
      *close() {
        if (phase === "busy") {
          throw new Error("Cannot close Scheme guest during advancement");
        }
        machine?.close();
        machine = undefined;
        current = undefined;
        phase = "closed";
      },
    };
    owned.set(guest, () => ({
      identity: options.identity,
      source: options.source,
      state: check().capture(),
      reason,
    }));
    return { guest, initialize };
  }
  return {
    *acquire() {
      return create().guest;
    },
    checkpoints: {
      format: "scheme-execution-v1",
      *capture(guest) {
        return owned.get(guest)?.();
      },
      *restore(snapshot) {
        if (
          !snapshot ||
          typeof snapshot !== "object" ||
          !("identity" in snapshot) ||
          snapshot.identity !== options.identity ||
          !("source" in snapshot) ||
          snapshot.source !== options.source ||
          !("state" in snapshot) ||
          typeof snapshot.state !== "string" ||
          ("reason" in snapshot &&
            snapshot.reason !== undefined &&
            typeof snapshot.reason !== "string")
        ) {
          throw new Error("Scheme checkpoint source/runtime mismatch or malformed state");
        }
        const created = create();
        const turn = yield* created.initialize({
          state: snapshot.state,
          reason: "reason" in snapshot ? (snapshot.reason as string | undefined) : undefined,
        });
        return { guest: created.guest, turn };
      },
    },
  };
}
