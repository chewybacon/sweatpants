import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition } from "@sweatpan.ts/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import type { EffectCapabilities } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ToolAcquisition, ToolContext, ToolDefinition } from "./contracts.ts";

/**
 * Assemble native tool acquisition as a scoped middleware API. The caller supplies
 * admitted input, installs handlers and retains the owning scope through delivery.
 * This does not admit input, open a journal, schedule a host or choose placement.
 */
export function createToolAcquisition<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
  Y,
>(
  runtime: Runtime<Y>,
  effects: EffectCapabilities<Y>,
  tool: ToolDefinition<S, D, L, R>,
  name: string,
): ToolAcquisition<StandardSchemaV1.InferOutput<S>, R, Y> {
  // Capability and elicitation aliases are separate authored namespaces.
  const selected: Record<string, EffectDefinition> = Object.fromEntries([
    ...Object.entries(tool.capabilities).map(([key, effect]) => [`capability:${key}`, effect]),
    ...Object.entries(tool.elicits).map(([key, effect]) => [`elicit:${key}`, effect]),
  ]);
  function fresh() {
    return effects.grant(selected, { record: true });
  }
  const current = runtime.composition.createContext<ReturnType<typeof fresh>>(`${name}:grant`);
  const api = runtime.composition.createApi<{
    acquire: ToolAcquisition<StandardSchemaV1.InferOutput<S>, R, Y>["operations"]["acquire"];
  }>(name, {
    *acquire(input) {
      const grant = fresh();
      yield* grant.install();
      yield* current.set(grant);
      const capabilities = Object.fromEntries(
        Object.entries(tool.capabilities).map(([key, effect]) => [key, effect.call]),
      ) as ToolContext<D, L, Y>["capabilities"];
      return createScopedGuest((scope) =>
        tool.body(input, {
          scope,
          capabilities,
          record: grant.record,
          *await(start, options) {
            const outcome = yield* grant.record(function* () {
              const value = yield* runtime.fromPromise(async (signal) => start(signal));
              return { ok: true as const, value };
            }, options.record);
            return outcome.value;
          },
          elicit<K extends keyof L>(key: K, ...args: Parameters<L[K]["call"]>) {
            return tool.elicits[key].call(args[0]) as ReturnType<L[K]["call"]>;
          },
        }),
      );
    },
  });
  return {
    ...api,
    admission: {
      *child(args, next) {
        const grant = yield* current.expect();
        return yield* grant.admission.child(args, next);
      },
    },
    *handle(request) {
      const grant = yield* current.expect();
      return yield* grant.handle(request);
    },
  };
}
