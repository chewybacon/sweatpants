import { canonicalJson } from "@sweatpants/foundation";
import { toPortableSchema } from "../schema/zod-adapter.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "effection";
import { z } from "zod";
import {
  documentRequestSchema,
  documentResultSchema,
  documentObservationSchema,
  type DocumentObservation,
  type DocumentRef,
} from "@sweatpants/durable-execution";
import { defineEffect } from "./durable-effect.ts";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";

export const documentEffect = defineEffect({
  name: "document.operate",
  version: "1",
  input: documentRequestSchema,
  output: documentResultSchema,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

export type DocumentSlots = Readonly<Record<string, StandardSchemaV1>>;
export type ReadonlyDocumentValue<T> = T extends readonly (infer V)[]
  ? readonly ReadonlyDocumentValue<V>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyDocumentValue<T[K]> }
    : T;
export type TypedDocumentObservation<T> = ReadonlyDocumentValue<
  Omit<DocumentObservation, "current"> & {
    readonly current: Omit<DocumentObservation["current"], "content"> & {
      readonly content: ReadonlyDocumentValue<T>;
    };
  }
>;
export interface ReadonlyDocumentHandle<T> {
  read(): Operation<TypedDocumentObservation<T>>;
}
export type ElicitDocumentSlots<E> = E extends { readonly documents: infer D extends DocumentSlots }
  ? D
  : {};
export type ElicitDocumentHandles<E> = {
  readonly [K in keyof ElicitDocumentSlots<E>]: ReadonlyDocumentHandle<
    ElicitDocumentSlots<E>[K] extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<ElicitDocumentSlots<E>[K]>
      : never
  >;
};
export type ElicitDocumentBindings<E> = keyof ElicitDocumentSlots<E> extends never
  ? {}
  : {
      readonly documents: {
        readonly [K in keyof ElicitDocumentSlots<E>]: DocumentRef & {
          readonly sinceRevision?: number;
        };
      };
    };

/** Wire envelope is separate from authored context; it is lowered once at the SDK boundary. */
export function documentElicitContextSchema(
  context: StandardSchemaV1 | undefined,
  slots: DocumentSlots,
): StandardSchemaV1 {
  const documents = Object.fromEntries(
    Object.keys(slots).map((name) => [name, documentObservationSchema]),
  );
  const contracts = Object.fromEntries(
    Object.entries({
      /* CONDITIONAL-SPREAD: Omit absent context from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
      ...(context ? { context } : {}),
      ...Object.fromEntries(
        Object.entries(slots).map(([name, schema]) => [`document:${name}`, schema]),
      ),
    }).map(([name, schema]) => [
      name,
      toPortableSchema(schema, {
        identity: `document-slot:${name}`,
        role: "elicit_context",
        version: "1",
      }).descriptor,
    ]),
  );
  return (
    z
      .strictObject({ context: z.json(), documents: z.strictObject(documents) })
      .superRefine((value, issues) => {
        if (context && validateAuthoredSchema(context, value.context).status !== "ok") {
          issues.addIssue({
            code: "custom",
            message: "Invalid interaction context",
            path: ["context"],
          });
        }
        for (const [name, schema] of Object.entries(slots)) {
          if (
            validateAuthoredSchema(schema, value.documents[name]?.current.content).status !== "ok"
          ) {
            issues.addIssue({
              code: "custom",
              message: "Invalid document content",
              path: ["documents", name],
            });
          }
        }
      })
      // Include the source contracts in the wire identity: changing a slot schema
      // must change the binding even though observations carry arbitrary JSON.
      .meta({ "x-sweatpants-document-contracts": canonicalJson(contracts) })
  );
}

/** Detached, immutable snapshot capability. No writer or authority credential reaches the client. */
export function createReadonlyDocumentHandle<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): ReadonlyDocumentHandle<T> {
  const observation = documentObservationSchema.parse(structuredClone(value));
  const checked = validateAuthoredSchema<T>(schema, observation.current.content);
  if (checked.status !== "ok") {
    throw new Error("Document content does not match its elicitation slot");
  }
  const snapshot = freeze({
    ...observation,
    current: { ...observation.current, content: checked.value },
  });
  return Object.freeze({
    *read() {
      return snapshot as TypedDocumentObservation<T>;
    },
  });
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }
  return value;
}
