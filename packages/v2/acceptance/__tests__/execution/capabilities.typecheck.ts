// Non-executed authoring tracers, checked against source and emitted declarations.
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  createEffectCapabilitiesRig,
  defineEffect,
  type CapabilityRequest,
} from "@sweatpan.ts/testing";

export function effectInference<Y>(
  runtime: Runtime<Y>,
  schema: StandardSchemaV1<string, { domain: string }>,
) {
  const effects = createEffectCapabilitiesRig(runtime, "types");
  const lookup = defineEffect({ key: "lookup", context: schema }, function* ({ domain }) {
    if (!domain) {
      return { ok: false, error: { code: "missing" as const } };
    }
    return { ok: true, value: { domain, count: 1 } };
  });
  const { capabilities } = effects.grant({ lookup });
  const result: Operation<
    Outcome<{ domain: string; count: number }, { code: "missing" }>,
    CapabilityRequest
  > = capabilities.lookup("example.com");
  effects.install(lookup);
  // @ts-expect-error The caller supplies schema input, not normalized handler input.
  capabilities.lookup({ domain: "example.com" });
  // @ts-expect-error Installation does not add an ungranted method to this facade.
  capabilities.sample({ messages: [] });
  // @ts-expect-error The inferred result has not widened to arbitrary reply types.
  const wrong: Operation<number, CapabilityRequest> = capabilities.lookup("example.com");
  // @ts-expect-error Replacement handlers retain the inferred success contract.
  effects.install(lookup, function* () {
    return { ok: true, value: 123 };
  });
  // @ts-expect-error Replacement failures must retain the inferred error contract.
  effects.install(lookup, function* () {
    return { ok: false, error: "different" };
  });
  // @ts-expect-error Bare handler values are not outcomes.
  defineEffect({ key: "bare", context: schema }, function* () {
    return 6;
  });
  effects.api(lookup).around({
    *handle([input], next) {
      const result = yield* next(input);
      if (!result.ok) {
        const code: "missing" = result.error.code;
        return { ok: false, error: { code } };
      }
      return result;
    },
  });
  return { result, wrong };
}

export function declaredExchangeInference<Y>(
  runtime: Runtime<Y>,
  context: StandardSchemaV1<string, { message: string }>,
  market: StandardSchemaV1<string, { market: string }>,
  count: StandardSchemaV1<string, number>,
) {
  const effects = createEffectCapabilitiesRig(runtime, "declaration-types");
  const transformed = defineEffect(
    { key: "transformed", context, response: market },
    function* ({ message }) {
      if (!message) {
        return { ok: false, error: { code: "empty" as const } };
      }
      return { ok: true, value: message };
    },
  );
  const transformedResult: Operation<
    Outcome<{ market: string }, { code: "empty" }>,
    CapabilityRequest
  > = transformed.call("Market?");
  effects.install(transformed);
  // @ts-expect-error Default handlers supply raw schema input inside success.
  defineEffect({ key: "bad-transform", context, response: market }, function* () {
    return { ok: true, value: 123 };
  });
  const chooseMarket = defineEffect({ key: "market", context, response: market });
  const chooseCount = defineEffect({ key: "count", context, response: count });
  effects.install(chooseMarket, function* ({ message }) {
    return { ok: true, value: message };
  });
  // @ts-expect-error A declaration without a default requires an implementation.
  effects.install(chooseMarket);
  // @ts-expect-error Handlers return raw response input; normalization belongs to the boundary.
  effects.install(chooseMarket, function* () {
    return { ok: true, value: { market: "Europe" } };
  });
  effects.api(chooseMarket).around({
    *handle([input], next) {
      const message: string = input.message;
      return yield* next({ message });
    },
  });
  effects.api(chooseMarket).around({
    // @ts-expect-error Middleware must preserve the raw response type.
    *handle() {
      return { ok: true as const, value: 123 };
    },
  });
  const ctx = effects.grant({ chooseMarket, chooseCount });
  const a: Operation<
    Outcome<{ market: string }, unknown>,
    CapabilityRequest
  > = ctx.capabilities.chooseMarket("Market?");
  const b: Operation<Outcome<number, unknown>, CapabilityRequest> = ctx.capabilities.chooseCount(
    "Count?",
  );
  // @ts-expect-error Each definition retains its own response correlation.
  const wrong: Operation<number, CapabilityRequest> = ctx.capabilities.chooseMarket("Market?");
  // @ts-expect-error Local work must be explicitly enabled by assembly.
  ctx.record(() => 6);
  return { a, b, wrong, transformedResult };
}

export function recordedInference<Y>(runtime: Runtime<Y>) {
  const effects = createEffectCapabilitiesRig(runtime, "record-types");
  const ctx = effects.grant({}, { record: true });
  const roll: Operation<{ ok: true; value: number }, CapabilityRequest> = ctx.record(() => ({
    ok: true,
    value: 6,
  }));
  const decision: Operation<Outcome<number, "empty">, CapabilityRequest> = ctx.record(() => {
    if (Math.random() > 0.5) {
      return { ok: false, error: "empty" as const };
    }
    return { ok: true, value: 6 };
  });
  // @ts-expect-error Callback result determines the success type.
  const wrong: Operation<Outcome<string, never>, CapabilityRequest> = ctx.record(() => ({
    ok: true,
    value: 6,
  }));
  // @ts-expect-error Bare values are not authored outcomes.
  ctx.record(() => 6);
  // @ts-expect-error Void is not an authored outcome.
  ctx.record(() => {});
  // @ts-expect-error Work must be deferred.
  ctx.record({ ok: true, value: 6 });
  // @ts-expect-error Async outcomes are not synchronous.
  ctx.record(async () => ({ ok: true as const, value: 6 }));
  const widened: Operation<unknown, CapabilityRequest> = ctx.record(() =>
    // @ts-expect-error Contextual widening cannot admit async work.
    Promise.resolve({ ok: true as const, value: 6 }),
  );
  ctx.record(() =>
    // @ts-expect-error Every return path must be synchronous.
    Math.random() > 0.5
      ? { ok: true as const, value: 6 }
      : Promise.resolve({ ok: true as const, value: 6 }),
  );
  // @ts-expect-error Even an Outcome-shaped callable thenable is asynchronous.
  ctx.record(() => ({
    ok: true as const,
    value: 6,
    // eslint-disable-next-line unicorn/no-thenable -- Deliberate negative type fixture.
    then(resolve: (value: number) => void) {
      resolve(6);
    },
  }));
  const empty: Operation<Outcome<void, never>, CapabilityRequest> = ctx.record(() => ({
    ok: true,
    value: undefined,
  }));
  return { roll, decision, wrong, widened, empty };
}

export function nativeDefaultInference(
  schema: StandardSchemaV1<string, string>,
  runtime: Runtime<"host">,
) {
  const definition = defineEffect({ key: "native", context: schema }, function* (): Operation<
    Outcome<string, never>,
    "foreign"
  > {
    yield "foreign";
    return { ok: true, value: "value" };
  });
  const effects = createEffectCapabilitiesRig(runtime, "native-default");
  // @ts-expect-error Moving a definition must not erase its default's native protocol.
  effects.install(definition);
  // This host can provide a compatible replacement for the same exchange contract.
  effects.install(definition, function* () {
    return { ok: true, value: "replacement" };
  });
  return definition;
}
