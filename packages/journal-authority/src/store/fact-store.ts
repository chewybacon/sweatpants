import {
  canonicalSnapshot,
  parser,
  sha256,
  stableTupleHash,
  type Json,
} from "@sweatpants/foundation";
import { z } from "zod";
import type {
  DurableReference,
  ProjectionFactEnvelope,
  ProjectionFrontier,
} from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import { createApi } from "effection/experimental";
import { useExecutionStore } from "../api.ts";

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
      const facts = request.facts.map(parseFact);
      assertFactList(request.executionId, facts);
      const factsValue: Json[] = facts.map((fact) => ({
        executionId: fact.executionId,
        sessionId: fact.sessionId,
        turnId: fact.turnId,
        sequence: fact.sequence,
        kind: fact.kind,
        payload: fact.payload,
      }));
      const encoded = canonicalSnapshot(factsValue);
      const contentHash = sha256(encoded.canonical);
      const objectId = stableTupleHash([request.executionId, "projection-facts", contentHash]);
      const byteLength = new TextEncoder().encode(encoded.canonical).byteLength;
      const store = yield* useExecutionStore();
      yield* store.putObject({
        objectId,
        lifetimeScope: "execution",
        scopeOwnerId: request.executionId,
        objectKind: "projection-facts",
        contentHash,
        byteLength,
        body: encoded.value,
        createdAt: Date.now(),
      });
      return {
        id: objectId,
        byteLength,
        version: "1",
        integrity: { algorithm: "sha256", value: contentHash },
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

const projectionFactEnvelopeParser = parser(
  z.strictObject({
    executionId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    sequence: z.number().int().safe().positive(),
    kind: z.string().min(1),
    payload: z.json(),
  }),
).map(
  (fact): ProjectionFactEnvelope => ({
    executionId: fact.executionId,
    sessionId: fact.sessionId,
    turnId: fact.turnId,
    sequence: fact.sequence,
    kind: fact.kind,
    payload: fact.payload,
  }),
);

function assertFactList(executionId: string, facts: readonly ProjectionFactEnvelope[]): void {
  facts.forEach((fact, index) => {
    if (fact.executionId !== executionId || fact.sequence !== index + 1) {
      throw new AcceptedProjectionFactsError(
        `Projection Fact ${index + 1} has an invalid accepted frontier`,
      );
    }
  });
}

function parseFact(value: unknown): ProjectionFactEnvelope {
  const result = projectionFactEnvelopeParser.parse(value);
  if (!result.ok) {
    throw new AcceptedProjectionFactsError("Projection Fact fields are invalid");
  }
  return result.value;
}
