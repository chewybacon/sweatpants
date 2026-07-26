import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import { createApi } from "effection/experimental";
import type { EffectDefinition } from "./contract.ts";

/** Versioned canonical document used to compare complete durable effect contracts. */
export interface EffectContractDigestDocumentV1 {
  readonly kind: "sweatpants.effect-contract";
  readonly digestVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly cancellationPartialSchemaDigest: string | null;
  readonly retrySafety: EffectDefinition["retrySafety"];
}

/** Computes compatibility identity for every normative field of an effect contract. */
export function effectContractDigest(definition: EffectDefinition<Json, Json, Json>): string {
  const document: EffectContractDigestDocumentV1 = {
    kind: "sweatpants.effect-contract",
    digestVersion: 1,
    name: definition.name,
    version: definition.version,
    inputSchemaDigest: definition.inputSchema.digest,
    outputSchemaDigest: definition.outputSchema.digest,
    cancellationPartialSchemaDigest: definition.cancellation?.partialSchema.digest ?? null,
    retrySafety: definition.retrySafety,
  };
  return canonicalSnapshot(document).sha;
}

export type DurableEffectRoute =
  | { readonly placement: "host" }
  | { readonly placement: "execution" };

/** Placement-neutral identity of the program requesting an effect. */
export interface EffectProgramIdentity {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface DurableEffectRoutingRequest {
  readonly definition: EffectDefinition<Json, Json, Json>;
  readonly effectContractDigest: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly program: EffectProgramIdentity;
  readonly programRoute: Json;
}

/** Host-default, scope-middleware-aware route selection for unresolved effects. */
export const DurableEffectRouting = createApi<{
  route(request: DurableEffectRoutingRequest): Operation<DurableEffectRoute>;
}>("durable-effect-routing", {
  *route() {
    return { placement: "host" };
  },
});

type LiveEffectCancellation = { readonly cancel: (reason?: string) => void };
const liveEffects = new Map<string, LiveEffectCancellation>();

function effectKey(sessionId: string, taskId: string, pullId: string, attemptId: string): string {
  return `${sessionId}\u0000${taskId}\u0000${pullId}\u0000${attemptId}`;
}

/** Registers an activation-local cancellation bridge; this state is never durable. */
export function registerLiveDurableEffect(
  sessionId: string,
  taskId: string,
  pullId: string,
  attemptId: string,
  cancel: (reason?: string) => void,
): () => void {
  const key = effectKey(sessionId, taskId, pullId, attemptId);
  const registration = { cancel };
  liveEffects.set(key, registration);
  return () => {
    if (liveEffects.get(key) === registration) {
      liveEffects.delete(key);
    }
  };
}

/** Signals every attached attempt for one pull without exposing its controller. */
export function signalLiveDurableEffect(
  sessionId: string,
  taskId: string,
  pullId: string,
  reason?: string,
): boolean {
  const prefix = `${sessionId}\u0000${taskId}\u0000${pullId}\u0000`;
  let signalled = false;
  for (const [key, registration] of liveEffects) {
    if (key.startsWith(prefix)) {
      signalled = true;
      registration.cancel(reason);
    }
  }
  return signalled;
}

/** Runtime-only settleability probe used while cancellation is accepted locally. */
export function hasLiveDurableEffect(sessionId: string, taskId: string, pullId: string): boolean {
  const prefix = `${sessionId}\u0000${taskId}\u0000${pullId}\u0000`;
  return [...liveEffects.keys()].some((key) => key.startsWith(prefix));
}
