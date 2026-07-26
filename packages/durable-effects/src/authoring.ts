import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import type { DurableEffectDisposition, EffectDefinition } from "./contract.ts";

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
