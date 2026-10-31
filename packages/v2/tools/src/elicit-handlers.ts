import type { Operation, Outcome } from "@standard-durability/core";
import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type { EffectCapabilities, Hosting } from "@sweatpan.ts/hosting";
import type { ElicitHandlers } from "./contracts.ts";

/**
 * Install scoped delivery policy for every declared elicitation. Supplied handlers
 * execute with normalized request context and return raw authored Outcomes through
 * existing effect delivery/response validation. Omitted handlers park through the
 * host's participant registration; use installEffectAnswers to submit later answers.
 * Unrelated effects delegate to surrounding middleware. Inner installations replace
 * policy for this tool's entire elicitation set and disappear on scope exit. Routing
 * uses min middleware, so ordinary outer middleware can wrap or bypass this policy.
 * Installation grants no authority, acquires no Guest, and sends no presentation
 * event; callers must install grant admission and participant storage separately.
 * Handler middleware remains available through effects.api(definition).around.
 */
export function* installElicitHandlers<L extends Record<string, EffectDefinition>, R, E, Y>(
  host: Hosting<R, CapabilityRequest, unknown, E, Y>,
  effects: EffectCapabilities<Y>,
  tool: { readonly elicits: L },
  handlers: ElicitHandlers<NoInfer<L>, Y> = {},
): Operation<void, Y> {
  const modes = new Map<string, "execute" | "wait">();
  for (const key of Object.keys(tool.elicits)) {
    const definition = tool.elicits[key];
    // Register identity even for participant routing, rejecting conflicting definitions.
    effects.api(definition);
    const handler = Object.hasOwn(handlers, key) ? handlers[key as keyof L] : undefined;
    if (handler) {
      // Iteration erases the per-key correlation only here; each handler is installed
      // against the same definition from which its public signature was inferred.
      yield* effects.install(
        definition,
        handler as (context: unknown) => Operation<Outcome<unknown, unknown>, Y>,
      );
    }
    modes.set(definition.id, handler ? "execute" : "wait");
  }
  yield* host.around(
    {
      *deliveryMode([request], next) {
        return modes.get(request.effect) ?? (yield* next(request));
      },
    },
    { at: "min" },
  );
}
