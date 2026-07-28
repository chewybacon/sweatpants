import { canonicalSnapshot } from "@sweatpants/foundation";
import type { Json } from "@sweatpants/foundation";
import { CrankError } from "./errors.ts";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
  type PortableSchemaRole,
} from "@sweatpants/foundation/schema-descriptor";
import type { EffectDefinition, RetrySafety } from "@sweatpants/durable-effects";
import type { DurableProgramFactory, DurableTool } from "./program-authoring.ts";
import type { DurableProgramManifest } from "./program-contract.ts";

export const DEFAULT_MAX_INLINE_BYTES = 1024 * 1024;

export function defineDurableEffect<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
>(definition: EffectDefinition<I, O, P>): EffectDefinition<I, O, P> {
  validateEffectDefinition(definition);
  return deepFreeze(structuredClone(definition));
}

export function defineDurableProgramManifest<I extends Json = Json, O extends Json = Json>(
  manifest: DurableProgramManifest<I, O>,
): DurableProgramManifest<I, O> {
  validateDurableManifest(manifest);
  return deepFreeze(structuredClone(manifest));
}

export function createPinnedDurableProgram<I extends Json = Json, O extends Json = Json>(
  manifest: DurableProgramManifest<I, O>,
  program: DurableProgramFactory<I, O>,
): DurableTool<I, O> {
  validateDurableManifest(manifest);
  if (typeof program !== "function" || isAsyncFunction(program)) {
    throw new CrankError(
      "invalid_manifest",
      "Durable program must be an Effection Operation factory",
    );
  }
  const tool: DurableTool<I, O> = {
    durability: "crank_native",
    manifest: deepFreeze(structuredClone(manifest)),
    program,
    identityProvenance: Object.freeze({ kind: "asserted" }),
  };
  return Object.freeze(tool);
}

export function validateDurableManifest(manifest: DurableProgramManifest): void {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    invalidManifest("manifest");
  requireId(manifest.programId, "programId");
  requireId(manifest.version, "version");
  if (typeof manifest.digest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.digest))
    invalidManifest("digest must be a lowercase SHA-256 hex value");
  validateDescriptorField(manifest.inputSchema, "program_input", "inputSchema");
  validateDescriptorField(manifest.outputSchema, "program_output", "outputSchema");
  if (!isRecord(manifest.elicits)) invalidManifest("elicits");
  for (const [key, declaration] of Object.entries(manifest.elicits)) {
    requireId(key, "elicit key");
    validateDescriptorField(declaration.response, "elicit_response", `elicits.${key}.response`);
    if (declaration.context !== undefined)
      validateDescriptorField(declaration.context, "elicit_context", `elicits.${key}.context`);
  }
  if (!isRecord(manifest.effects)) invalidManifest("effects");
  for (const [key, definition] of Object.entries(manifest.effects) as Array<
    [string, EffectDefinition<Json, Json, Json>]
  >) {
    validateEffectDefinition(definition);
    if (definition.name !== key) invalidManifest(`effect key ${key} must equal its symbolic name`);
  }
  if (
    !manifest.capabilities ||
    manifest.capabilities.replay !== "strict" ||
    typeof manifest.capabilities.durableEmissions !== "boolean" ||
    typeof manifest.capabilities.structuredChildren !== "boolean"
  )
    invalidManifest("capabilities");
  canonicalSnapshot(manifest);
}

export function validateEffectDefinition(definition: EffectDefinition<Json, Json, Json>): void {
  if (!definition || typeof definition !== "object") invalidManifest("effect definition");
  requireId(definition.name, "effect name");
  requireId(definition.version, "effect version");
  validateDescriptorField(definition.inputSchema, "effect_input", `${definition.name}.inputSchema`);
  validateDescriptorField(
    definition.outputSchema,
    "effect_output",
    `${definition.name}.outputSchema`,
  );
  if (definition.cancellation !== undefined)
    validateDescriptorField(
      definition.cancellation.partialSchema,
      "effect_cancellation_partial",
      `${definition.name}.cancellation.partialSchema`,
    );
  validateRetrySafety(definition.retrySafety, `${definition.name}.retrySafety`);
}

function validateRetrySafety(safety: RetrySafety, path: string): void {
  if (
    !safety ||
    (safety.mode === "repeatable" && Object.keys(safety).length !== 1) ||
    (safety.mode === "unsafe" && Object.keys(safety).length !== 1) ||
    (safety.mode === "idempotent" &&
      (Object.keys(safety).length !== 2 ||
        (safety.mechanism !== "pull_id_key" && safety.mechanism !== "inherent"))) ||
    (safety.mode !== "repeatable" && safety.mode !== "unsafe" && safety.mode !== "idempotent")
  )
    invalidManifest(path);
}

function validateDescriptorField(
  descriptor: PortableSchemaDescriptor,
  role: PortableSchemaRole,
  path: string,
): void {
  let parsed: PortableSchemaDescriptor;
  try {
    parsed = parsePortableSchemaDescriptor(descriptor);
  } catch (error) {
    throw new CrankError(
      "invalid_manifest",
      `Invalid durable manifest: ${path} is not a portable schema descriptor`,
      undefined,
      { cause: error },
    );
  }
  if (parsed.role !== role && parsed.role !== "builtin")
    invalidManifest(`${path} descriptor role must be ${role}`);
}
function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalidManifest(`${field} must be non-empty`);
  return value;
}
function invalidManifest(message: string): never {
  throw new CrankError("invalid_manifest", `Invalid durable manifest: ${message}`);
}
function isAsyncFunction(value: Function): boolean {
  return (
    value.constructor.name === "AsyncFunction" ||
    value.constructor.name === "AsyncGeneratorFunction"
  );
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
