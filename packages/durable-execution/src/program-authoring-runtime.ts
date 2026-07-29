import { canonicalSnapshot } from "@sweatpants/foundation";
import type { Json } from "@sweatpants/foundation";
import { CrankError } from "./errors.ts";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { validateEffectDefinition } from "@sweatpants/durable-effects/authoring";
import type { EffectDefinition } from "@sweatpants/durable-effects/contract";
import type { DurableProgramFactory, DurableTool } from "./program-authoring.ts";
import type { DurableProgramManifest } from "./program-contract.ts";

export const DEFAULT_MAX_INLINE_BYTES = 1024 * 1024;

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

function validateDescriptorField(
  descriptor: PortableSchemaDescriptor,
  role: string,
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
