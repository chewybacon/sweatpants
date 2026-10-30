import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Api, Operation, Outcome } from "@standard-durability/core";
import { recordDefinition } from "./record-definition.ts";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type { EffectCapabilities, EffectGrant } from "./contracts.ts";

type EffectImplementation<C, R, E, Y> = (context: C) => Operation<Outcome<R, E>, Y>;
type EffectMethods<C, R, E, Y> = { handle(context: C): Operation<Outcome<R, E>, Y> };

/** Check the result envelope once at delivery; payloads remain application-owned. */
function assertOutcome(value: unknown): asserts value is Outcome<unknown, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    (value.ok !== true && value.ok !== false) ||
    !(value.ok ? "value" in value : "error" in value)
  ) {
    throw new Error("Effect work must return an Outcome");
  }
}

/**
 * Create host-owned effect installation, middleware and grants.
 * Grants are trusted assembly, not remote credentials. Install admission before routing.
 * Recorded implementations belong to the Guest acquisition scope. Grant and install
 * a fresh context per acquisition so ordered identities reconstruct during replay.
 */
export function createEffectCapabilities<Y>(
  runtime: Runtime<Y>,
  name: string,
): EffectCapabilities<Y> {
  const definitions = new Map<
    string,
    {
      definition: object;
      api: Api<EffectMethods<unknown, unknown, unknown, Y>, Y>;
      handle(input: unknown): Operation<Outcome<unknown, string>, Y>;
      respond(outcome: Outcome<unknown, unknown>): Operation<Outcome<unknown, unknown>, Y>;
    }
  >();

  function* parse<S extends StandardSchemaV1>(
    schema: S,
    input: unknown,
  ): Operation<StandardSchemaV1.InferOutput<S>, Y> {
    const result = yield* runtime.fromPromise(async () => schema["~standard"].validate(input));
    if (result.issues) {
      throw new Error("Effect schema rejected value");
    }
    return result.value;
  }

  function prepare(definition: EffectDefinition) {
    const existing = definitions.get(definition.id);
    if (existing) {
      if (existing.definition !== definition) {
        throw new Error("Conflicting effect definitions");
      }
      return existing;
    }
    const api = runtime.composition.createApi<EffectMethods<unknown, unknown, unknown, Y>>(
      `${name}:${definition.id}`,
      {
        *handle() {
          throw new Error("Effect handler is not installed");
        },
      },
    );
    const prepared = {
      definition,
      api,
      *handle(input: unknown): Operation<Outcome<unknown, string>, Y> {
        const normalized = yield* parse(definition.context, input);
        const outcome = yield* api.operations.handle(normalized);
        return { ok: true, value: yield* prepared.respond(outcome) };
      },
      *respond(outcome: Outcome<unknown, unknown>): Operation<Outcome<unknown, unknown>, Y> {
        assertOutcome(outcome);
        return outcome.ok && definition.response
          ? { ok: true, value: yield* parse(definition.response, outcome.value) }
          : outcome;
      },
    };
    definitions.set(definition.id, prepared);
    return prepared;
  }

  /** Host-owned scoped API for this declaration; rejects conflicting objects with the same key. */
  function api<C, R, I, O, E>(
    definition: EffectDefinition<C, R, I, O, E>,
  ): Api<EffectMethods<C, O, E, Y>, Y> {
    // The host registry erases heterogeneous definitions, not public callable types.
    // Identity checks ensure this API always belongs to this exact declaration.
    return prepare(definition).api as Api<EffectMethods<C, O, E, Y>, Y>;
  }

  /** Install a compatible default or replacement in the current scope, never on the definition. */
  function install<C, R, I, O, E>(
    definition: EffectDefinition<C, R, I, O, E> & {
      readonly implementation: EffectImplementation<C, O, E, Y>;
    },
  ): Operation<void, Y>;
  function install<C, R, I, O, E>(
    definition: EffectDefinition<C, R, I, O, E>,
    handler: EffectImplementation<NoInfer<C>, NoInfer<O>, NoInfer<E>, Y>,
  ): Operation<void, Y>;
  function* install<C, R, I, O, E>(
    definition: EffectDefinition<C, R, I, O, E> & {
      readonly implementation?: EffectImplementation<C, O, E, Y>;
    },
    handler = definition.implementation,
  ): Operation<void, Y> {
    if (!handler) {
      throw new Error("Effect implementation is required");
    }
    yield* api(definition).install({ handle: handler });
  }

  function bindRecordedWork() {
    let slot = 0;
    let installed = false;
    let active = false;
    let executing = false;
    let pending:
      | { key: string; sequence: number; work: () => Operation<Outcome<unknown, unknown>, Y> }
      | undefined;
    return {
      *install(): Operation<void, Y> {
        if (installed) {
          throw new Error("Record binding already installed");
        }
        installed = true;
        yield* runtime.composition.ensure(function* () {
          active = false;
          pending = undefined;
        });
        yield* install(recordDefinition, function* (invocation) {
          if (
            !active ||
            !pending ||
            pending.key !== invocation.key ||
            pending.sequence !== invocation.sequence
          ) {
            throw new Error("Record invocation is unavailable");
          }
          const work = pending.work;
          pending = undefined;
          executing = true;
          try {
            const operation = work();
            if (!operation || typeof operation[Symbol.iterator] !== "function") {
              void Promise.resolve(operation).catch(() => undefined);
              throw new Error("Recorded work must return an Operation");
            }
            return yield* operation;
          } finally {
            executing = false;
          }
        });
        active = true;
      },
      *call<Result extends Outcome<unknown, unknown>>(
        work: () => Operation<Result, Y>,
        options: { readonly key?: string } = {},
      ): Operation<Result, CapabilityRequest> {
        if (!active) {
          throw new Error("Record binding is not live");
        }
        if (executing) {
          throw new Error("Nested recorded work is not supported");
        }
        const key = options.key === undefined ? "$position" : options.key;
        if (typeof key !== "string" || !key.trim()) {
          throw new Error("Record key must be non-empty");
        }
        const invocation = { key, sequence: slot++, work };
        // A fresh boundary supersedes the previous callback. Logical cancellation
        // can abandon its iterator without resuming it, then enter recorded cleanup.
        // Only executing work is nesting; stale deliveries still fail key/sequence
        // matching above. This binding belongs to one sequential Guest incarnation.
        pending = invocation;
        // Heterogeneous callbacks erase Result only inside this per-Guest binding.
        // The matching invocation's accepted Outcome restores that correlation.
        const result = (yield* recordDefinition.call({
          key: invocation.key,
          sequence: invocation.sequence,
        })) as Result;
        if (pending === invocation) {
          pending = undefined;
        }
        return result;
      },
    };
  }

  /** Bind selected declarations to this host. Local record permission is explicit and per Guest. */
  function grant<const D extends Record<string, EffectDefinition>>(selected: D): EffectGrant<D, Y>;
  function grant<const D extends Record<string, EffectDefinition>>(
    selected: D,
    local: { record: true },
  ): EffectGrant<D, Y> & {
    record: ReturnType<typeof bindRecordedWork>["call"];
    install: ReturnType<typeof bindRecordedWork>["install"];
  };
  function grant<const D extends Record<string, EffectDefinition>>(
    selected: D,
    local?: { record: true },
  ) {
    const permitted = new Map<string, ReturnType<typeof prepare>>();
    const facade: Record<string, unknown> = {};
    for (const [alias, effect] of Object.entries(selected)) {
      const registered = prepare(effect);
      permitted.set(effect.id, registered);
      facade[alias] = effect.call;
    }
    const recorded = local?.record ? bindRecordedWork() : undefined;
    if (recorded) {
      permitted.set(recordDefinition.id, prepare(recordDefinition));
    }
    function resolve(request: CapabilityRequest) {
      const handler = permitted.get(request.effect);
      if (!handler) {
        throw new Error("Effect is not granted");
      }
      return handler;
    }
    return {
      capabilities: Object.freeze(facade) as { readonly [K in keyof D]: D[K]["call"] },
      record: recorded?.call,
      install: recorded?.install,
      admission: {
        *child<P extends { readonly request: CapabilityRequest }, R>(
          [pending]: [P],
          next: (pending: P) => Operation<R, Y>,
        ): Operation<R, Y> {
          resolve(pending.request);
          return yield* next(pending);
        },
      },
      *respond(
        request: CapabilityRequest,
        outcome: Outcome<unknown, unknown>,
      ): Operation<Outcome<unknown, unknown>, Y> {
        return yield* resolve(request).respond(outcome);
      },
      *handle(request: CapabilityRequest): Operation<Outcome<unknown, string>, Y> {
        return yield* resolve(request).handle(request.input);
      },
    };
  }
  return { install, api, grant };
}
