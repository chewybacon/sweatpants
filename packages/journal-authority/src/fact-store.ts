import { canonicalSnapshot, stableTupleHash, type Json } from "@sweatpants/foundation";
import type {
  DurableReference,
  ProjectionFactEnvelope,
  ProjectionFrontier,
} from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import { createApi } from "effection/experimental";
import { useExecutionStore } from "./api.ts";

export interface PutFactsRequest<TFact> {
  readonly executionId: string;
  readonly facts: readonly TFact[];
}

export interface ReadFactsRequest {
  readonly executionId: string;
  readonly frontier: ProjectionFrontier;
}

export interface FactStore<TFact> {
  put(request: PutFactsRequest<TFact>): Operation<DurableReference>;
  read(request: ReadFactsRequest): Operation<readonly TFact[]>;
}

export class AcceptedProjectionFactsError extends Error {
  readonly code = "accepted_projection_facts_invalid";

  constructor(message: string) {
    super(message);
    this.name = "AcceptedProjectionFactsError";
  }
}

/**
 * Middleware-wrapped accepted projection-facts store. The terminal handlers
 * use the current ExecutionStore facade, so physical storage middleware stays
 * in the call path without capturing or binding a Scope.
 */
export const AcceptedProjectionFactStore = createApi<FactStore<ProjectionFactEnvelope>>(
  "accepted-projection-facts",
  {
    *put(request: PutFactsRequest<ProjectionFactEnvelope>): Operation<DurableReference> {
      assertFactList(request.executionId, request.facts);
      const factsValue: Json[] = request.facts.map((fact) => ({
        executionId: fact.executionId,
        sessionId: fact.sessionId,
        turnId: fact.turnId,
        sequence: fact.sequence,
        kind: fact.kind,
        payload: fact.payload,
      }));
      const encoded = canonicalSnapshot(factsValue);
      const objectId = stableTupleHash([request.executionId, "projection-facts", encoded.sha]);
      const byteLength = new TextEncoder().encode(encoded.canonical).byteLength;
      const store = yield* useExecutionStore();
      yield* store.putObject({
        objectId,
        lifetimeScope: "execution",
        scopeOwnerId: request.executionId,
        objectKind: "projection-facts",
        contentHash: encoded.sha,
        byteLength,
        body: encoded.value,
        createdAt: Date.now(),
      });
      return {
        id: objectId,
        byteLength,
        version: "1",
        integrity: { algorithm: "sha256", value: encoded.sha },
      };
    },

    *read(request: ReadFactsRequest): Operation<readonly ProjectionFactEnvelope[]> {
      const frontier = request.frontier;
      if (frontier.throughSequence === 0) return [];
      if (!frontier.facts) {
        throw new AcceptedProjectionFactsError(
          "Accepted Projection Facts frontier has no reference",
        );
      }
      const store = yield* useExecutionStore();
      const stored = yield* store.getObject({ objectId: frontier.facts.id });
      if (!stored || stored.body instanceof Uint8Array || !Array.isArray(stored.body)) {
        throw new AcceptedProjectionFactsError("Accepted Projection Facts payload is unavailable");
      }
      if (stored.lifetimeScope === "execution" && stored.scopeOwnerId !== request.executionId) {
        throw new AcceptedProjectionFactsError(
          "Accepted Projection Facts are outside execution scope",
        );
      }
      const facts = stored.body.map(parseFact);
      assertFactList(request.executionId, facts);
      if (facts.length !== frontier.throughSequence) {
        throw new AcceptedProjectionFactsError(
          `Expected ${frontier.throughSequence} accepted Projection Facts, received ${facts.length}`,
        );
      }
      return facts;
    },
  },
);

function assertFactList(executionId: string, facts: readonly ProjectionFactEnvelope[]): void {
  facts.forEach((fact, index) => {
    if (
      fact === null ||
      typeof fact !== "object" ||
      Array.isArray(fact) ||
      fact.executionId !== executionId ||
      typeof fact.sessionId !== "string" ||
      typeof fact.turnId !== "string" ||
      typeof fact.sequence !== "number" ||
      !Number.isSafeInteger(fact.sequence) ||
      fact.sequence !== index + 1 ||
      typeof fact.kind !== "string" ||
      !("payload" in fact)
    ) {
      throw new AcceptedProjectionFactsError(
        `Projection Fact ${index + 1} has an invalid accepted frontier`,
      );
    }
  });
}

function parseFact(value: Json): ProjectionFactEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcceptedProjectionFactsError("Projection Fact must be an object");
  }
  const fact = value as Record<string, Json>;
  if (
    typeof fact["executionId"] !== "string" ||
    typeof fact["sessionId"] !== "string" ||
    typeof fact["turnId"] !== "string" ||
    typeof fact["sequence"] !== "number" ||
    !Number.isSafeInteger(fact["sequence"]) ||
    typeof fact["kind"] !== "string" ||
    !("payload" in fact)
  ) {
    throw new AcceptedProjectionFactsError("Projection Fact fields are invalid");
  }
  return {
    executionId: fact["executionId"],
    sessionId: fact["sessionId"],
    turnId: fact["turnId"],
    sequence: fact["sequence"],
    kind: fact["kind"],
    payload: fact["payload"],
  };
}
