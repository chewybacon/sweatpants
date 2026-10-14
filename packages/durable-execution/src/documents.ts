import { z } from "zod";
import { canonicalJson, type Json } from "@sweatpants/foundation";

export const documentRefSchema = z.strictObject({ id: z.string().min(1).max(256) });
export const documentPatchSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set"),
    path: z.array(z.string().max(256)).max(32),
    value: z.json(),
  }),
  z.strictObject({ op: z.literal("remove"), path: z.array(z.string().max(256)).min(1).max(32) }),
]);
export const documentRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create"),
    name: z.string().min(1).max(256),
    content: z.json(),
  }),
  z.strictObject({
    operation: z.literal("read"),
    document: documentRefSchema,
    sinceRevision: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    operation: z.literal("edit"),
    document: documentRefSchema,
    expectedRevision: z.number().int().positive(),
    patches: z.array(documentPatchSchema).min(1).max(64),
  }),
]);
export type DocumentRequest = z.infer<typeof documentRequestSchema>;
export type DocumentPatch = z.infer<typeof documentPatchSchema>;
export type DocumentRef = z.infer<typeof documentRefSchema>;
export const documentSnapshotSchema = z.strictObject({
  document: documentRefSchema,
  name: z.string(),
  revision: z.number().int().positive(),
  content: z.json(),
});
export const documentObservationSchema = z.strictObject({
  current: documentSnapshotSchema,
  changes: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("reset") }),
    z.strictObject({
      kind: z.literal("delta"),
      from: z.number().int().positive(),
      to: z.number().int().positive(),
      patches: z.array(documentPatchSchema),
    }),
  ]),
});
export type DocumentObservation = z.infer<typeof documentObservationSchema>;
export const documentResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), observation: documentObservationSchema }),
  z.strictObject({ status: z.literal("conflict"), current: documentSnapshotSchema }),
  z.strictObject({
    status: z.literal("error"),
    code: z.enum(["not_found", "invalid_patch", "limit_exceeded", "invalid_revision"]),
  }),
]);
export type DocumentResult = z.infer<typeof documentResultSchema>;
export const workflowDocumentStateSchema = z.strictObject({
  documents: z
    .array(
      z.strictObject({
        owner: z.string(),
        current: documentSnapshotSchema,
        history: z
          .array(
            z.strictObject({
              revision: z.number().int().positive(),
              patches: z.array(documentPatchSchema),
            }),
          )
          .max(32),
      }),
    )
    .max(32),
  receipts: z
    .array(
      z.strictObject({
        owner: z.string(),
        key: z.string(),
        digest: z.string(),
        result: documentResultSchema,
      }),
    )
    .max(512),
});
export type WorkflowDocumentState = z.infer<typeof workflowDocumentStateSchema>;

/** Pure, bounded JSON edits. Paths are explicit segments, never executable property expressions. */
export function applyDocumentPatches(content: Json, patches: readonly DocumentPatch[]): Json {
  let value = structuredClone(content);
  for (const patch of patches) {
    if (patch.path.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) {
      throw new Error("Unsafe path");
    }
    if (patch.path.length === 0) {
      if (patch.op !== "set") {
        throw new Error("Cannot remove document root");
      }
      value = structuredClone(patch.value);
      continue;
    }
    let parent: Json = value;
    for (const key of patch.path.slice(0, -1)) {
      if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key)) {
        throw new Error("Missing parent");
      }
      parent = (parent as Record<string, Json>)[key]!;
    }
    if (parent === null || typeof parent !== "object") {
      throw new Error("Invalid parent");
    }
    const key = patch.path.at(-1)!;
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) {
        throw new Error("Invalid array index");
      }
      const index = Number(key);
      if (index > parent.length || (patch.op === "remove" && index === parent.length)) {
        throw new Error("Array index out of bounds");
      }
      if (patch.op === "remove") {
        parent.splice(index, 1);
      } else {
        parent[index] = structuredClone(patch.value);
      }
    } else {
      if (patch.op === "remove") {
        if (!Object.hasOwn(parent, key)) {
          throw new Error("Missing property");
        }
        delete parent[key];
      } else {
        parent[key] = structuredClone(patch.value);
      }
    }
  }
  if (new TextEncoder().encode(canonicalJson(value)).length > 16_384) {
    throw new Error("Document too large");
  }
  return value;
}
