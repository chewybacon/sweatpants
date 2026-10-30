import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { All, Branch, CapabilityRequest } from "@sweatpan.ts/core";
import { defineEffect } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { OwnedAll } from "./contracts.ts";

/**
 * Assemble inline all from an ordinary effect and owned journal groups. Names must
 * be stable and distinct within a pinned parent program. No factory crosses storage.
 * The host supplies child contexts and execution through install's run operation.
 */
export function createOwnedAll<C, I, Y>(runtime: Runtime<Y>, name: string): OwnedAll<C, I, Y> {
  type Position = { slot: number; count: number };
  const effect = defineEffect<StandardSchemaV1<Position>, StandardSchemaV1<readonly unknown[]>>({
    key: name,
    context: {
      "~standard": {
        version: 1,
        vendor: "owned-all",
        validate(value) {
          const position = value as Position | null;
          return position &&
            Number.isSafeInteger(position.slot) &&
            position.slot >= 0 &&
            Number.isSafeInteger(position.count) &&
            position.count > 0
            ? { value: position }
            : { issues: [{ message: "Invalid owned group position" }] };
        },
      },
    },
    response: {
      "~standard": {
        version: 1,
        vendor: "owned-all",
        validate(value) {
          return Array.isArray(value)
            ? { value }
            : { issues: [{ message: "Expected group results" }] };
        },
      },
    },
  });
  const current = runtime.composition.createContext<Map<number, readonly Branch<C, I>[]>>(
    `${name}:branches`,
  );
  return {
    effect,
    *acquire() {
      let slot = 0;
      let active = true;
      const bindings = new Map<number, readonly Branch<C, I>[]>();
      yield* current.set(bindings);
      yield* runtime.composition.ensure(function* () {
        active = false;
        bindings.clear();
      });
      const all: All<C, I> = function* <const B extends readonly Branch<C, I>[]>(...branches: B) {
        if (!active) {
          throw new Error("Owned all authoring scope is closed");
        }
        type Results = { -readonly [K in keyof B]: B[K] extends Branch<C, I, infer R> ? R : never };
        if (!branches.length) {
          return [] as Results;
        }
        const position = slot++;
        bindings.set(position, branches);
        const result = yield* effect.call({ slot: position, count: branches.length });
        bindings.delete(position);
        if (!result.ok) {
          throw new Error("Owned group failed");
        }
        return result.value as Results;
      };
      return all;
    },
    *install({ host, journal, recovery, run }) {
      yield* host.around({
        *child([pending], next) {
          if (pending.request.effect !== effect.id) {
            return yield* next(pending);
          }
          // Trusted local request: membership is checked against live reconstructed
          // bindings below. Remote ingress must authenticate/decode before this layer.
          const position = pending.request.input as Position;
          return {
            id: pending.id,
            run() {
              return runtime.composition.scoped(function* () {
                const state = yield* journal.read();
                if (state.status !== "running" || state.pending?.id !== pending.id) {
                  throw new Error("Stale owned group");
                }
                // Never inherit an ancestor's registry. Every routed group rebuilds
                // its own parent in this scope, even if a same-slot registry is visible.
                yield* current.set(new Map());
                const restored = yield* recovery.operations.recover({
                  ...state,
                  checkpoint: undefined,
                });
                const turn = restored.turn;
                const actual =
                  turn.kind === "suspended" ? (turn.request.input as Position) : undefined;
                if (
                  turn.kind !== "suspended" ||
                  turn.request.effect !== effect.id ||
                  actual?.slot !== position.slot ||
                  actual?.count !== position.count ||
                  turn.scope?.scopeId !== pending.scope?.scopeId ||
                  turn.scope?.frameId !== pending.scope?.frameId ||
                  turn.scope?.phase !== pending.scope?.phase ||
                  turn.scope?.critical !== pending.scope?.critical
                ) {
                  throw new Error("Owned group replay differs from pending boundary");
                }
                const bindings = yield* current.get();
                const factories = bindings?.get(position.slot);
                if (!factories || factories.length !== position.count) {
                  throw new Error("Owned branch bindings unavailable");
                }
                const children = yield* journal.ensureChildren<
                  unknown,
                  CapabilityRequest,
                  unknown,
                  string
                >(pending.id, {
                  children: factories.map((_, index) => ({
                    program: `${state.program}/${effect.id}/all:${position.slot}/branch:${index}`,
                    input: { slot: position.slot, index },
                  })),
                  outcome: (values) => ({ ok: true, value: { ok: true, value: values } }),
                });
                const settled = yield* runtime.all(
                  children.map((child, index) => () => run(child, factories[index]!, index)),
                );
                return settled.every(Boolean);
              });
            },
          };
        },
      });
    },
  };
}
