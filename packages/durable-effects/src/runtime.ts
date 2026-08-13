import { assertJson, canonicalSnapshot, stableTupleHash, type Json } from "@sweatpants/foundation";
import { z } from "zod";
import { createContext, type Operation } from "effection";
import { createApi } from "effection/experimental";
import type { EffectDefinition, OperationOutcome } from "./contract.ts";
import type {
  DurableEffectAuthorization,
  DurableEffectRegistration,
  DurableEffectRegistry,
} from "./authoring.ts";

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
export class DurableEffectConfigurationError extends Error {
  readonly code: "unknown_target" | "invalid_manifest";

  constructor(code: "unknown_target" | "invalid_manifest", message: string) {
    super(message);
    this.name = "DurableEffectConfigurationError";
    this.code = code;
  }
}

/** One canonical scoped registry identity for durable effect dispatch. */
export const DurableEffectRegistryContext = createContext<DurableEffectRegistry | undefined>(
  "durable-effects:registry",
  undefined,
);

export function durableEffectKey(name: string, version: string): string {
  return stableTupleHash([name, version]);
}

/** Validates exact authored contracts against their selected handlers. */
export function assertDurableEffectBindings(
  requiredDefinitions: Iterable<EffectDefinition<Json, Json, Json>>,
  registry: DurableEffectRegistry,
): void {
  for (const required of requiredDefinitions) {
    const registration = registry.get(durableEffectKey(required.name, required.version));
    if (!registration) {
      throw new DurableEffectConfigurationError(
        "unknown_target",
        `No durable effect handler for ${required.name}@${required.version}`,
      );
    }
    if (effectContractDigest(registration.definition) !== effectContractDigest(required)) {
      throw new DurableEffectConfigurationError(
        "invalid_manifest",
        `Effect contract differs for ${required.name}@${required.version}`,
      );
    }
  }
}

/** Creates the immutable registry owned by durable-effects. */
export function createDurableEffectRegistry(
  registrations: Iterable<DurableEffectRegistration>,
  requiredDefinitions: Iterable<EffectDefinition<Json, Json, Json>> = [],
): DurableEffectRegistry {
  const registry = new Map<string, DurableEffectRegistration>();
  for (const registration of registrations) {
    const definition = registration.definition;
    const key = durableEffectKey(definition.name, definition.version);
    if (registry.has(key)) {
      throw new DurableEffectConfigurationError(
        "invalid_manifest",
        `Duplicate effect ${definition.name}@${definition.version}`,
      );
    }
    if (registration.handler.constructor.name === "AsyncFunction") {
      throw new DurableEffectConfigurationError(
        "invalid_manifest",
        "Durable effect handlers must return Effection Operations, not Promises",
      );
    }
    if (
      registration.satisfies.mode !== definition.retrySafety.mode ||
      (definition.retrySafety.mode === "idempotent" &&
        (registration.satisfies.mode !== "idempotent" ||
          registration.satisfies.mechanism !== definition.retrySafety.mechanism))
    ) {
      throw new DurableEffectConfigurationError(
        "invalid_manifest",
        `Handler does not satisfy retry contract for ${definition.name}`,
      );
    }
    registry.set(key, registration);
  }
  assertDurableEffectBindings(requiredDefinitions, registry);
  return registry;
}

export function* useDurableEffectRegistry(): Operation<DurableEffectRegistry> {
  const registry = yield* DurableEffectRegistryContext.get();
  if (!registry) {
    throw new DurableEffectConfigurationError(
      "unknown_target",
      "No durable effect registry is installed",
    );
  }
  return registry;
}

const MAX_INLINE_BYTES = 1024 * 1024;

/** Canonical host-effect dispatch API. Authority orchestration resolves its returned outcome. */
export const DurableEffects = createApi("durable-effects:execute", {
  *execute(authorization: DurableEffectAuthorization): Operation<OperationOutcome> {
    const registry = yield* useDurableEffectRegistry();
    const registration = registry.get(
      durableEffectKey(authorization.descriptor.name, authorization.descriptor.version),
    );
    if (!registration) {
      throw new DurableEffectConfigurationError(
        "unknown_target",
        `No durable effect handler for ${authorization.descriptor.name}@${authorization.descriptor.version}`,
      );
    }
    if (effectContractDigest(registration.definition) !== authorization.effectContractDigest) {
      throw new DurableEffectConfigurationError(
        "invalid_manifest",
        `Effect contract differs for ${authorization.descriptor.name}@${authorization.descriptor.version}`,
      );
    }
    const input = canonicalSnapshot(assertJson(authorization.descriptor.input)).value;
    const controller = new AbortController();
    const release = registerLiveDurableEffect(
      authorization.sessionId,
      authorization.taskId,
      authorization.pullId,
      authorization.attemptId,
      (reason) => controller.abort(reason),
    );
    try {
      const operation = registration.handler(input, {
        sessionId: authorization.sessionId,
        taskId: authorization.taskId,
        pullId: authorization.pullId,
        attemptId: authorization.attemptId,
        cancellation: controller.signal,
        resolver: authorization.resolver,
      });
      if (!isOperation(operation)) {
        throw new DurableEffectConfigurationError(
          "invalid_manifest",
          "Durable effect handler returned a Promise or plain value",
        );
      }
      const disposition = yield* operation;
      if (disposition.status === "ok") {
        const value = canonicalSnapshot(assertJson(disposition.value)).value;
        if (
          new TextEncoder().encode(canonicalSnapshot(value).canonical).byteLength > MAX_INLINE_BYTES
        ) {
          throw new DurableEffectConfigurationError(
            "invalid_manifest",
            "Durable effect payload is too large",
          );
        }
        return { status: "ok", value };
      }
      if (disposition.status === "cancelled") {
        return disposition.partial === undefined
          ? { status: "cancelled" }
          : { status: "cancelled", partial: canonicalSnapshot(disposition.partial).value };
      }
      return { status: "error", error: disposition.error };
    } catch (error) {
      if (controller.signal.aborted) return { status: "cancelled" };
      return {
        status: "error",
        error: {
          code: errorCode(error),
          message: error instanceof Error ? error.message : "Durable effect failed",
        },
      };
    } finally {
      release();
      if (!controller.signal.aborted) controller.abort();
    }
  },
});

function errorCode(error: unknown): string {
  const parsed = z.object({ code: z.string() }).loose().safeParse(error);
  return parsed.success ? parsed.data.code : "effect_failed";
}

function isOperation(value: unknown): value is Operation<unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function",
  );
}

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

interface LiveEffectRegistration {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly cancel: (reason?: string) => void;
}

const liveEffects = new Map<string, LiveEffectRegistration>();

function effectKey(sessionId: string, taskId: string, pullId: string, attemptId: string): string {
  return stableTupleHash([sessionId, taskId, pullId, attemptId]);
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
  const registration: LiveEffectRegistration = {
    sessionId,
    taskId,
    pullId,
    attemptId,
    cancel,
  };
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
  let signalled = false;
  for (const registration of liveEffects.values()) {
    if (
      registration.sessionId === sessionId &&
      registration.taskId === taskId &&
      registration.pullId === pullId
    ) {
      signalled = true;
      registration.cancel(reason);
    }
  }
  return signalled;
}

/** Runtime-only settleability probe used while cancellation is accepted locally. */
export function hasLiveDurableEffect(sessionId: string, taskId: string, pullId: string): boolean {
  return [...liveEffects.values()].some(
    (registration) =>
      registration.sessionId === sessionId &&
      registration.taskId === taskId &&
      registration.pullId === pullId,
  );
}
