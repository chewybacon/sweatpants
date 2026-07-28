import { CrankError } from "@sweatpants/durable-execution";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import {
  assertJson,
  createPortableSchemaDescriptor,
  type DurableSchemaRegistryEntry,
  type Json,
  type PortableSchemaDescriptor,
  type PortableSchemaRole,
} from "@sweatpants/session-contract";

/**
 * First-party Zod → Standard Schema adapter.
 *
 * Zod remains the authoring implementation: validation flows through the
 * schema's `~standard.validate` Standard Schema interface, and portable
 * draft-2020-12 JSON Schema projections are generated with `z.toJSONSchema`
 * per role (`io: "input"` for pre-validation wire roles, `io: "output"` for
 * canonical persisted roles). Projection failure is an authoring-time
 * `schema_projection_unavailable` error; the adapter never silently
 * substitutes an unconstrained schema.
 */

/** Options for lowering one authoring schema into a portable descriptor. */
export interface PortableSchemaOptions {
  /** Explicit semantic schema identity, e.g. `yo-chat.pick-card/input`. */
  readonly identity: string;
  /** Acceptance-boundary role for this schema. */
  readonly role: PortableSchemaRole;
  /**
   * Explicit semantic schema version. Changing refinements, transforms,
   * defaults, coercions, or any other validator behavior REQUIRES a new
   * version even when the generated JSON Schema is unchanged; tooling cannot
   * detect forgotten semantic bumps inside arbitrary validator code.
   */
  readonly version: string;
  /**
   * Explicit trusted output projection supplied by the author when the
   * transformed output cannot be generated (`z.toJSONSchema` throws for
   * `io: "output"`). Marks output fidelity `explicit` and participates in the
   * descriptor digest.
   */
  readonly outputProjection?: Json;
  /** Explicit trusted input projection for non-Zod Standard Schema vendors. */
  readonly inputProjection?: Json;
}

/** Result of lowering one runtime schema: portable descriptor + registry entry. */
export interface LoweredSchema {
  readonly descriptor: PortableSchemaDescriptor;
  readonly entry: DurableSchemaRegistryEntry;
}

/** True when a value exposes the Standard Schema V1 validation interface. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  const standard = (value as { "~standard"?: { version?: number; validate?: unknown } })?.[
    "~standard"
  ];
  return Boolean(standard && standard.version === 1 && typeof standard.validate === "function");
}

/**
 * Lowers a Standard Schema (first-party: Zod 4) to a portable schema
 * descriptor plus its digest-keyed registry entry.
 *
 * Non-Zod vendors are accepted only when they supply explicit trusted
 * input/output JSON Schema projections (DR-011).
 */
export function toPortableSchema(
  schema: StandardSchemaV1,
  options: PortableSchemaOptions,
): LoweredSchema {
  if (!isStandardSchema(schema)) {
    throw new CrankError(
      "invalid_schema_descriptor",
      `Schema for ${options.identity} does not implement Standard Schema V1`,
    );
  }
  const vendor = schema["~standard"].vendor;
  let inputProjection: Json;
  let outputProjection: Json;
  let inputFidelity: "lossless" | "explicit";
  let outputFidelity: "lossless" | "explicit";

  if (options.inputProjection !== undefined) {
    inputProjection = withSchemaId(assertJson(options.inputProjection), options, "input");
    inputFidelity = "explicit";
  } else if (vendor === "zod") {
    inputProjection = withSchemaId(
      projectZodJsonSchema(schema, "input", options.identity),
      options,
      "input",
    );
    inputFidelity = "lossless";
  } else {
    throw projectionUnavailable(options.identity, vendor, "input");
  }

  if (options.outputProjection !== undefined) {
    outputProjection = withSchemaId(assertJson(options.outputProjection), options, "output");
    outputFidelity = "explicit";
  } else if (vendor === "zod") {
    outputProjection = withSchemaId(
      projectZodJsonSchema(schema, "output", options.identity),
      options,
      "output",
    );
    outputFidelity = "lossless";
  } else {
    throw projectionUnavailable(options.identity, vendor, "output");
  }

  const descriptor = createPortableSchemaDescriptor({
    identity: options.identity,
    role: options.role,
    version: options.version,
    vendor,
    inputProjection,
    outputProjection,
    fidelity: { input: inputFidelity, output: outputFidelity },
  });
  return { descriptor, entry: { descriptor, schema } };
}

function projectZodJsonSchema(
  schema: StandardSchemaV1,
  io: "input" | "output",
  identity: string,
): Json {
  try {
    // SAFETY: vendor === "zod" guarantees this object is a Zod schema.
    return assertJson(
      z.toJSONSchema(schema as unknown as z.ZodType, { target: "draft-2020-12", io }),
    );
  } catch (error) {
    throw new CrankError(
      "schema_projection_unavailable",
      `Cannot generate ${io} JSON Schema projection for ${identity}; ` +
        "supply an explicit trusted projection for transformed schemas",
      undefined,
      { cause: error },
    );
  }
}

function withSchemaId(
  projection: Json,
  options: PortableSchemaOptions,
  io: "input" | "output",
): Json {
  if (projection === null || typeof projection !== "object" || Array.isArray(projection)) {
    return projection;
  }
  return {
    ...projection,
    $id: `sweatpants:schema:${options.identity}@${options.version}:${options.role}:${io}`,
  };
}

function projectionUnavailable(identity: string, vendor: string, io: string): CrankError {
  return new CrankError(
    "schema_projection_unavailable",
    `Vendor "${vendor}" schema for ${identity} requires an explicit trusted ${io} projection`,
  );
}
