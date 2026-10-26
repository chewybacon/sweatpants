import type { StandardSchemaV1 } from "@standard-schema/spec";
import { assertJson, canonicalJson, type Json } from "@sweatpants/foundation";
import type { Api, Composition, Operation, Operations } from "@sweatpants/standard-durability";
import type {
  ApiDefinition,
  AnyOperation,
  InputOf,
  OperationDefinitions,
  Outcome,
  OutcomeOf,
  Signature,
} from "@sweatpants/standard-durability";

/** The serializable boundary. Identity/version/policy are checked against the declaration. */
export type ApiRequest = {
  readonly kind: "api";
  readonly api: string;
  readonly method: string;
  readonly version: string;
  readonly input: Json;
  readonly retrySafety: { readonly mode: "repeatable" | "unsafe" };
};
export type GuestOperations<D extends OperationDefinitions> = {
  readonly [K in keyof D]: (input: InputOf<D[K]>) => Operation<OutcomeOf<D[K]>, ApiRequest>;
};
export interface HostBinding<D extends OperationDefinitions, Y> extends Api<Signature<D>, Y> {
  /** Transport entry: validates metadata/input and final middleware output before acceptance. */
  dispatch(request: ApiRequest): Operation<Outcome<unknown, unknown>, Y>;
  /** Existing journal convention: domain Outcome is the successful exchange value. */
  handle(request: ApiRequest): Operation<Outcome<Json, never>, Y>;
}
export interface Host<Y> {
  use<D extends OperationDefinitions>(definition: ApiDefinition<D>): HostBinding<D, Y>;
}

/** Scaffold constraint: synchronous validation of canonical JSON without transformations.
 * Revalidating replay must not silently transform an already transformed value again.
 */
function validate(schema: StandardSchemaV1, value: unknown): unknown {
  const json = assertJson(value);
  const original = canonicalJson(json);
  const result = schema["~standard"].validate(json);
  if ("then" in result) {
    // Observe rejected validation promises even though this synchronous boundary refuses them.
    void Promise.resolve(result).catch(() => undefined);
    throw new Error("Async schemas require a native validation adapter");
  }
  if (result.issues) {
    throw new Error("API schema validation failed");
  }
  if (canonicalJson(assertJson(result.value)) !== original) {
    throw new Error("Transforming schemas require an explicit wire codec");
  }
  return result.value;
}
function validateOutcome(definition: AnyOperation, value: unknown): Outcome<unknown, unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new Error("Expected an API Outcome");
  }
  if (value.ok === true && "value" in value) {
    return { ok: true, value: validate(definition.success, value.value) };
  }
  if (value.ok === false && "error" in value) {
    return { ok: false, error: validate(definition.failure, value.error) };
  }
  throw new Error("Expected an API Outcome");
}

export const guest = {
  use<D extends OperationDefinitions>(definition: ApiDefinition<D>): GuestOperations<D> {
    // Dynamic enumeration erases correlation; restore it once at the mapped facade boundary.
    return Object.fromEntries(
      Object.entries(definition.operations).map(([method, spec]) => [
        method,
        function* (input: unknown): Operation<Outcome<unknown, unknown>, ApiRequest> {
          const request: ApiRequest = {
            kind: "api",
            api: definition.id,
            method,
            version: spec.version,
            input: assertJson(validate(spec.input, input)),
            retrySafety: { mode: spec.retrySafety },
          };
          const outcome = yield request;
          return validateOutcome(spec, outcome);
        },
      ]),
    ) as GuestOperations<D>;
  },
};

/** Declaration caching only: no current scope or global runtime is captured. */
export function createHost<Y>(composition: Composition<Y>): Host<Y> {
  const cache = new WeakMap<object, unknown>();
  const identities = new Map<string, object>();
  return {
    use<D extends OperationDefinitions>(definition: ApiDefinition<D>): HostBinding<D, Y> {
      const cached = cache.get(definition);
      if (cached) {
        return cached as HostBinding<D, Y>;
      }
      const previous = identities.get(definition.id);
      if (previous && previous !== definition) {
        throw new Error(`Conflicting API identity: ${definition.id}`);
      }
      const defaults = Object.fromEntries(
        Object.keys(definition.operations).map((key) => [
          key,
          function* () {
            throw new Error(`API driver not installed: ${definition.id}.${key}`);
          },
        ]),
      ) as unknown as Operations<Signature<D>, Y>;
      const api = composition.createApi<Signature<D>>(`durable-api:${definition.id}`, defaults);
      const bound: HostBinding<D, Y> = {
        ...api,
        *dispatch(request) {
          const spec = Object.hasOwn(definition.operations, request.method)
            ? definition.operations[request.method]
            : undefined;
          if (
            request.kind !== "api" ||
            request.api !== definition.id ||
            !spec ||
            request.version !== spec.version ||
            request.retrySafety.mode !== spec.retrySafety
          ) {
            throw new Error("API request identity, version or retry policy mismatch");
          }
          const input = validate(spec.input, request.input);
          // This lookup follows validation of the operation key. Native scopes and
          // middleware still own dispatch; no raw provider escapes the facade.
          const invoke = api.operations[request.method] as (
            input: unknown,
          ) => Operation<unknown, Y>;
          const outcome = yield* invoke(input);
          return validateOutcome(spec, outcome);
        },
        *handle(request) {
          const outcome = yield* bound.dispatch(request);
          return { ok: true, value: assertJson(outcome) };
        },
      };
      identities.set(definition.id, definition);
      cache.set(definition, bound);
      return bound;
    },
  };
}

/** Public convenience view over the explicit guest.use / host.use mechanism. */
export function bindApi<D extends OperationDefinitions, Y>(
  definition: ApiDefinition<D>,
  host: Host<Y>,
) {
  return { operations: guest.use(definition), host: host.use(definition) };
}
