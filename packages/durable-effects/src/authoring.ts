import type { StandardSchemaV1 } from "@standard-schema/spec";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { parsePortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { Operation } from "effection";
import type { DurableEffectDisposition, EffectDefinition } from "./contract.ts";

export class DurableEffectDefinitionError extends Error {
  readonly code = "invalid_manifest";
  constructor(message: string) {
    super(`Invalid durable effect: ${message}`);
    this.name = "DurableEffectDefinitionError";
  }
}

/** Defines, validates, clones, and freezes one durable effect contract. */
export function defineDurableEffect<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
>(definition: EffectDefinition<I, O, P>): EffectDefinition<I, O, P> {
  validateEffectDefinition(definition);
  return deepFreeze(structuredClone(definition));
}

export function validateEffectDefinition(definition: EffectDefinition<Json, Json, Json>): void {
  if (!definition || typeof definition !== "object") invalid("effect definition");
  requireId(definition.name, "effect name");
  requireId(definition.version, "effect version");
  validateDescriptor(definition.inputSchema, "effect_input", `${definition.name}.inputSchema`);
  validateDescriptor(definition.outputSchema, "effect_output", `${definition.name}.outputSchema`);
  if (definition.cancellation !== undefined) {
    validateDescriptor(
      definition.cancellation.partialSchema,
      "effect_cancellation_partial",
      `${definition.name}.cancellation.partialSchema`,
    );
  }
  const safety = definition.retrySafety;
  if (
    !safety ||
    (safety.mode === "repeatable" && Object.keys(safety).length !== 1) ||
    (safety.mode === "unsafe" && Object.keys(safety).length !== 1) ||
    (safety.mode === "idempotent" &&
      (Object.keys(safety).length !== 2 ||
        (safety.mechanism !== "pull_id_key" && safety.mechanism !== "inherent"))) ||
    (safety.mode !== "repeatable" && safety.mode !== "unsafe" && safety.mode !== "idempotent")
  ) {
    invalid(`${definition.name}.retrySafety`);
  }
  canonicalSnapshot(definition);
}

function validateDescriptor(
  value: unknown,
  role: "effect_input" | "effect_output" | "effect_cancellation_partial",
  path: string,
): void {
  let descriptor;
  try {
    descriptor = parsePortableSchemaDescriptor(value);
  } catch {
    invalid(`${path} is not a portable schema descriptor`);
  }
  if (descriptor.role !== role && descriptor.role !== "builtin") {
    invalid(`${path} descriptor role must be ${role}`);
  }
}

function requireId(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) invalid(`${field} must be non-empty`);
}

function invalid(message: string): never {
  throw new DurableEffectDefinitionError(message);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Host dispatch authorization with stable attempt identity and resolver audience. */
export interface DurableEffectAuthorization {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly descriptor: {
    readonly name: string;
    readonly version: string;
    readonly input: Json;
    readonly resolver: { readonly audience: string; readonly route?: string };
  };
  readonly effectContractDigest: string;
  readonly resolutionCapability: string;
  readonly resolver: { readonly audience: string; readonly route?: string };
}

/** Scope-owned context passed to one durable effect handler. */
export interface DurableEffectContext {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly cancellation: AbortSignal;
  readonly resolver: { readonly audience: string; readonly route?: string };
}

/** An Effection-native durable effect handler. */
export type DurableEffectHandler<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
> = (input: I, context: DurableEffectContext) => Operation<DurableEffectDisposition<O, P>>;

/** Effect handler registration proving compatibility with its retry declaration. */
export interface DurableEffectRegistration {
  readonly definition: EffectDefinition<Json, Json, Json>;
  readonly handler: DurableEffectHandler<Json, Json, Json>;
  readonly satisfies:
    | { readonly mode: "repeatable" }
    | { readonly mode: "unsafe" }
    | { readonly mode: "idempotent"; readonly mechanism: "pull_id_key" | "inherent" };
}

/** Immutable symbolic registration map installed by composition. */
export type DurableEffectRegistry = ReadonlyMap<string, DurableEffectRegistration>;

export interface DurableEffectRuntimeSchemas {
  readonly input?: StandardSchemaV1;
  readonly output?: StandardSchemaV1;
}

const registrationSchemas = new WeakMap<object, DurableEffectRuntimeSchemas>();

export function durableEffectRuntimeSchemas(
  registration: object,
): DurableEffectRuntimeSchemas | undefined {
  return registrationSchemas.get(registration);
}

/** Associates runtime validators with any package-owned registration object. */
export function attachDurableEffectRuntimeSchemas(
  registration: object,
  schemas: DurableEffectRuntimeSchemas,
): void {
  registrationSchemas.set(registration, schemas);
}

export function createDurableEffectRegistration<
  I extends Json,
  O extends Json,
  P extends Json = never,
>(
  definition: EffectDefinition<I, O, P>,
  satisfies: DurableEffectRegistration["satisfies"],
  handler: (input: I, context: DurableEffectContext) => Operation<DurableEffectDisposition<O, P>>,
  schemas?: DurableEffectRuntimeSchemas,
): DurableEffectRegistration {
  const registration: DurableEffectRegistration = {
    definition: definition as EffectDefinition<Json, Json, Json>,
    satisfies,
    handler(input, context) {
      return handler(input as I, context) as Operation<DurableEffectDisposition<Json, Json>>;
    },
  };
  if (schemas) attachDurableEffectRuntimeSchemas(registration, schemas);
  return registration;
}
