import { z } from "zod";
import { canonicalSnapshot } from "@sweatpants/foundation";
import type { Json } from "@sweatpants/foundation";
import { CrankError } from "./errors.ts";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { assertEffectDefinition } from "@sweatpants/durable-effects/authoring";
import type { EffectDefinition } from "@sweatpants/durable-effects/contract";
import type { DurableProgramFactory, DurableTool } from "./program-authoring.ts";
import type { DurableProgramManifest } from "./program-contract.ts";

export const DEFAULT_MAX_INLINE_BYTES = 1024 * 1024;

export function defineDurableProgramManifest<I extends Json = Json, O extends Json = Json>(
  manifest: DurableProgramManifest<I, O>,
): DurableProgramManifest<I, O> {
  return deepFreeze(
    structuredClone(parseDurableManifest(manifest)) as DurableProgramManifest<I, O>,
  );
}

export function createPinnedDurableProgram<I extends Json = Json, O extends Json = Json>(
  manifest: DurableProgramManifest<I, O>,
  program: DurableProgramFactory<I, O>,
): DurableTool<I, O> {
  const parsedManifest = parseDurableManifest(manifest) as DurableProgramManifest<I, O>;
  if (typeof program !== "function" || isAsyncFunction(program)) {
    throw new CrankError(
      "invalid_manifest",
      "Durable program must be an Effection Operation factory",
    );
  }
  const tool: DurableTool<I, O> = {
    durability: "crank_native",
    manifest: deepFreeze(structuredClone(parsedManifest)),
    program,
    identityProvenance: Object.freeze({ kind: "asserted" }),
  };
  return Object.freeze(tool);
}

const jsonValueSchema = z.json();
const descriptorSchema = z.record(z.string(), jsonValueSchema);
const durableManifestShapeSchema = z
  .object({
    programId: z.string().min(1).max(512),
    version: z.string().min(1).max(128),
    digest: z.string().min(1).max(128),
    inputSchema: descriptorSchema,
    outputSchema: descriptorSchema,
    elicits: z.record(
      z.string().min(1).max(512),
      z
        .object({
          response: descriptorSchema,
          context: descriptorSchema.optional(),
          contextContract: descriptorSchema.optional(),
        })
        .strict(),
    ),
    effects: z.record(z.string().min(1).max(512), z.record(z.string(), jsonValueSchema)),
    capabilities: z
      .object({
        durableEmissions: z.boolean(),
        structuredChildren: z.boolean(),
        replay: z.literal("strict"),
      })
      .strict(),
  })
  .strict();

/** Parses a complete durable manifest from an untrusted distribution value. */
export function parseDurableManifest(value: unknown): DurableProgramManifest {
  let parsed: DurableProgramManifest;
  try {
    parsed = durableManifestShapeSchema.parse(value) as unknown as DurableProgramManifest;
  } catch {
    throw new CrankError("invalid_manifest", "Invalid durable manifest shape");
  }
  verifyDurableManifest(parsed);
  return canonicalSnapshot(parsed).value as unknown as DurableProgramManifest;
}

/** Verifies semantic descriptor roles, effect identity, and canonical manifest form. */
export function verifyDurableManifest(manifest: DurableProgramManifest): void {
  requireId(manifest.programId, "programId");
  requireId(manifest.version, "version");
  if (!/^[0-9a-f]{64}$/.test(manifest.digest)) {
    invalidManifest("digest must be a lowercase SHA-256 hex value");
  }
  assertDescriptorField(manifest.inputSchema, "program_input", "inputSchema");
  assertDescriptorField(manifest.outputSchema, "program_output", "outputSchema");
  for (const [key, declaration] of Object.entries(manifest.elicits)) {
    requireId(key, "elicit key");
    assertDescriptorField(declaration.response, "elicit_response", `elicits.${key}.response`);
    if (declaration.context !== undefined)
      assertDescriptorField(declaration.context, "elicit_context", `elicits.${key}.context`);
  }
  for (const [key, definition] of Object.entries(manifest.effects) as Array<
    [string, EffectDefinition<Json, Json, Json>]
  >) {
    assertEffectDefinition(definition);
    if (definition.name !== key) invalidManifest(`effect key ${key} must equal its symbolic name`);
  }
  canonicalSnapshot(manifest);
}

function assertDescriptorField(
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
