import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Api, Operation, Outcome } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { CapabilityRequest, EffectDefinition } from "./contracts.ts";

type EffectImplementation<C, R, E, Y> = (context: C) => Operation<Outcome<R, E>, Y>;
type EffectMethods<C, R, E, Y> = { handle(context: C): Operation<Outcome<R, E>, Y> };

type Grant<D extends Record<string, EffectDefinition>, Y> = {
  readonly capabilities: { readonly [K in keyof D]: D[K]["call"] };
  /** Install as outer child middleware, before routing; it admits without executing or parsing. */
  readonly admission: {
    child<P extends { readonly request: CapabilityRequest }, R>(
      args: [P],
      next: (pending: P) => Operation<R, Y>,
    ): Operation<R, Y>;
  };
  handle(request: CapabilityRequest): Operation<Outcome<unknown, string>, Y>;
};

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

/** Testing-only authoring experiment; grants are trusted assembly, not remote credentials. */
export function createEffectCapabilitiesRig<Y>(runtime: Runtime<Y>, name: string) {
  const definitions = new Map<
    string,
    {
      definition: object;
      api: Api<EffectMethods<unknown, unknown, unknown, Y>, Y>;
      handle(input: unknown): Operation<Outcome<unknown, string>, Y>;
    }
  >();
  const recordId = "$record";

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
        assertOutcome(outcome);
        const value =
          outcome.ok && definition.response
            ? { ok: true as const, value: yield* parse(definition.response, outcome.value) }
            : outcome;
        return { ok: true, value };
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

  /**
   * Local synchronous Outcome-returning work only. Fresh Guest acquisition rebuilds these slots.
   * Authored failures are replayable values; thrown exceptions remain delivery errors.
   * Thenables are rejected before settlement; observing their rejection does not
   * await or cancel any async work that an untyped callback already started.
   */
  function bindRecordedWork() {
    const callbacks = new Map<number, () => unknown>();
    let slot = 0;
    let executing = false;
    return {
      *call<Result extends Outcome<unknown, unknown>>(
        work: (() => Result) &
          (Extract<Result, { then: (...args: never[]) => unknown }> extends never
            ? unknown
            : never),
      ): Operation<Result, CapabilityRequest> {
        if (executing) {
          throw new Error("Nested recorded work is not supported");
        }
        const key = slot++;
        callbacks.set(key, work);
        return (yield { effect: recordId, input: key }) as Result;
      },
      *handle(input: unknown): Operation<Outcome<unknown, string>, Y> {
        const work = typeof input === "number" ? callbacks.get(input) : undefined;
        if (!work) {
          throw new Error("Recorded work was not reconstructed");
        }
        executing = true;
        try {
          const value = work();
          if (
            ((typeof value === "object" && value !== null) || typeof value === "function") &&
            "then" in value &&
            typeof value.then === "function"
          ) {
            // Observe rejected async results without accepting or awaiting them.
            void Promise.resolve(value).catch(() => undefined);
            throw new Error("Recorded work must return a synchronous value");
          }
          assertOutcome(value);
          // The delivery succeeded; its value is the author's success or failure.
          // A failed transport reply would throw into the Guest instead.
          return { ok: true, value };
        } finally {
          executing = false;
        }
      },
    };
  }

  /** Bind selected declarations to this host. Local record permission is explicit and per Guest. */
  function grant<const D extends Record<string, EffectDefinition>>(selected: D): Grant<D, Y>;
  function grant<const D extends Record<string, EffectDefinition>>(
    selected: D,
    local: { record: true },
  ): Grant<D, Y> & { record: ReturnType<typeof bindRecordedWork>["call"] };
  function grant<const D extends Record<string, EffectDefinition>>(
    selected: D,
    local?: { record: true },
  ) {
    const permitted = new Map<string, (input: unknown) => Operation<Outcome<unknown, string>, Y>>();
    const facade: Record<string, unknown> = {};
    for (const [alias, effect] of Object.entries(selected)) {
      const registered = prepare(effect);
      permitted.set(effect.id, registered.handle);
      facade[alias] = effect.call;
    }
    const recorded = local?.record ? bindRecordedWork() : undefined;
    if (recorded) {
      permitted.set(recordId, recorded.handle);
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
      admission: {
        *child<P extends { readonly request: CapabilityRequest }, R>(
          [pending]: [P],
          next: (pending: P) => Operation<R, Y>,
        ): Operation<R, Y> {
          resolve(pending.request);
          return yield* next(pending);
        },
      },
      *handle(request: CapabilityRequest): Operation<Outcome<unknown, string>, Y> {
        return yield* resolve(request)(request.input);
      },
    };
  }
  return { install, api, grant };
}
