import { z } from "zod";

import type { SchemaBinding } from "@sweatpants/foundation/schema-descriptor";
import { type PortableSchemaDescriptor } from "@sweatpants/foundation/schema-descriptor";

import { toPortableSchema } from "../schema/zod-adapter.ts";
import { RESOURCE_SEARCH_MATCH_SEMANTICS, type ReaderOperation } from "./types.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const classification = z.enum(["public", "internal", "confidential", "restricted"]);
const ref = z.strictObject({
  packageId: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/),
  packageDigest: digest,
  path: z.string().min(1),
});
const provenance = {
  classifications: z.array(classification),
  sources: z.array(z.strictObject({ packageDigest: digest, fileDigest: digest })),
};
const exactRefInput = z.union([
  z.strictObject({ uri: z.string().startsWith("resource://") }),
  z.strictObject({ ref }),
]);
const statOutput = z.strictObject({
  ref,
  uri: z.string().startsWith("resource://"),
  mediaType: z.string().min(1),
  size: z.number().int().nonnegative(),
  fileDigest: digest,
  ...provenance,
});
const listEntry = z.strictObject({
  logicalPath: z.string().min(1),
  ref,
  uri: z.string().startsWith("resource://"),
  mediaType: z.string().min(1),
  size: z.number().int().nonnegative(),
  fileDigest: digest,
  classification: classification.optional(),
});
const listOutput = z.strictObject({
  entries: z.array(listEntry),
  truncated: z.boolean(),
  cursor: z.string().min(1).optional(),
  ...provenance,
});
const readBase = {
  packageDigest: digest,
  fileDigest: digest,
  ...provenance,
};
const readOutput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: z.string(),
    mediaType: z.string().startsWith("text/"),
    ...readBase,
  }),
  z.strictObject({
    kind: z.literal("json"),
    value: z.json(),
    mediaType: z.literal("application/json"),
    ...readBase,
  }),
  z.strictObject({
    kind: z.literal("bytes"),
    bytesBase64: z.base64(),
    mediaType: z.string().min(1),
    ...readBase,
  }),
]);
const searchOutput = z.strictObject({
  matchSemantics: z.literal(RESOURCE_SEARCH_MATCH_SEMANTICS),
  matches: z.array(
    z.strictObject({
      path: z.string().min(1),
      uri: z.string().startsWith("resource://"),
      excerpt: z.string(),
      packageDigest: digest,
      fileDigest: digest,
      classification,
    }),
  ),
  truncated: z.boolean(),
  ...provenance,
});

const operationSchemas = {
  stat: { input: exactRefInput, output: statOutput },
  list: {
    input: z.strictObject({ prefix: z.string().optional(), cursor: z.string().min(1).optional() }),
    output: listOutput,
  },
  read: { input: exactRefInput, output: readOutput },
  search: { input: z.strictObject({ query: z.string().min(1) }), output: searchOutput },
} satisfies Record<ReaderOperation, { input: z.ZodType; output: z.ZodType }>;

export interface ReaderSchemaArtifacts {
  readonly input: PortableSchemaDescriptor;
  readonly output: PortableSchemaDescriptor;
  readonly catalog: readonly SchemaBinding[];
}

const cache = new Map<ReaderOperation, ReaderSchemaArtifacts>();

/** Returns concrete closed schemas for one generated reader operation. */
export function readerSchemaArtifacts(operation: ReaderOperation): ReaderSchemaArtifacts {
  const existing = cache.get(operation);
  if (existing) {
    return existing;
  }
  const schemas = operationSchemas[operation];
  const input = toPortableSchema(schemas.input, {
    identity: `sweatpants.resource-reader.${operation}.input`,
    role: "program_input",
    version: "1",
  });
  const output = toPortableSchema(schemas.output, {
    identity: `sweatpants.resource-reader.${operation}.output`,
    role: "program_output",
    version: "1",
  });
  const artifacts = Object.freeze({
    input: input.descriptor,
    output: output.descriptor,
    catalog: Object.freeze([input.entry, output.entry]),
  });
  cache.set(operation, artifacts);
  return artifacts;
}
