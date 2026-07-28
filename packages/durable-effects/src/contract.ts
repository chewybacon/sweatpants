import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema-descriptor";

/** Portable schema descriptor required to pin an effect contract. */
export type EffectSchemaDescriptor = PortableSchemaDescriptor;

/** Retry policy declaring whether duplicate host execution is safe. */
export type RetrySafety =
  | { readonly mode: "repeatable" }
  | { readonly mode: "unsafe" }
  | { readonly mode: "idempotent"; readonly mechanism: "pull_id_key" | "inherent" };

declare const effectInputType: unique symbol;
declare const effectOutputType: unique symbol;
declare const effectCancellationPartialType: unique symbol;

/** Versioned effect contract carrying portable schema identities. */
export interface EffectDefinition<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
> {
  readonly [effectInputType]?: I;
  readonly [effectOutputType]?: O;
  readonly [effectCancellationPartialType]?: P;
  readonly name: string;
  readonly version: string;
  readonly inputSchema: EffectSchemaDescriptor;
  readonly outputSchema: EffectSchemaDescriptor;
  readonly cancellation?: { readonly partialSchema: EffectSchemaDescriptor };
  readonly retrySafety: RetrySafety;
}

/** Journaled host-effect request bound to an explicit resolver audience. */
export interface EffectDescriptor {
  readonly kind: "effect";
  readonly name: string;
  readonly version: string;
  readonly input: Json;
  readonly resolver: { readonly audience: string; readonly route?: string };
}

/** Safe serialized expected failure passed across durable boundaries. */
/**
 * Declared as a type alias rather than an interface deliberately: interfaces get
 * no implicit index signature, so an interface member makes the whole
 * `OperationOutcome` algebra unassignable to `Json` even though every field is
 * JSON-shaped. Journal entries are stored as `Json`, so that assignability is
 * load-bearing.
 */
export type SerializedEffectError = {
  readonly code: string;
  readonly message: string;
  readonly details?: Json;
};

/** Closed durable outcome algebra for effect and record pulls. */
export type OperationOutcome =
  | { readonly status: "ok"; readonly value: Json }
  | { readonly status: "error"; readonly error: SerializedEffectError }
  | { readonly status: "cancelled"; readonly partial?: Json };

/** Closed terminal report returned by every durable effect handler. */
export type DurableEffectDisposition<O extends Json, P extends Json = never> =
  | { readonly status: "ok"; readonly value: O }
  | { readonly status: "error"; readonly error: SerializedEffectError }
  | ([P] extends [never]
      ? { readonly status: "cancelled"; readonly partial?: never }
      : { readonly status: "cancelled"; readonly partial?: P });
