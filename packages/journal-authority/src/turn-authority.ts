import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  completeRoot,
  parseTerminalCapsule,
  type ExecutionTreeSnapshot,
  type ProgramIdentity,
  type ProjectionFactEnvelope,
  type StoredJson,
  type TerminalCapsule,
} from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import { createApi } from "effection/experimental";
import { ExecutionStoreApi } from "./api.ts";
import { runExecutionCommitLoop } from "./commit-loop.ts";

export interface OpenAuthorityTurnRequest {
  readonly executionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly rootTaskId: string;
  readonly rootProgram: ProgramIdentity;
}

export interface CompleteAuthorityTurnRequest {
  readonly executionId: string;
  readonly outcome: StoredJson;
  readonly disposition: TerminalCapsule["disposition"];
  readonly completedAt: number;
  readonly facts: readonly ProjectionFactEnvelope[];
}

export class TurnAuthorityBoundaryError extends Error {
  readonly code = "turn_authority_boundary_invalid";
  constructor(message: string) {
    super(message);
    this.name = "TurnAuthorityBoundaryError";
  }
}

/**
 * Journal Authority operations for the bounded terminal/publication lifecycle.
 * Persistence is reached only through ExecutionStoreApi; callers never receive
 * or thread a concrete store driver.
 */
export const TurnJournalAuthority = createApi("turn-journal-authority", {
  *open(request: OpenAuthorityTurnRequest): Operation<ExecutionTreeSnapshot | TerminalCapsule> {
    return yield* runExecutionCommitLoop(
      ExecutionStoreApi.operations,
      request.executionId,
      function* (current) {
        if (current) {
          assertIdentity(current.record, request);
          return { status: "return", result: current.record };
        }
        const snapshot = initialSnapshot(request);
        return { status: "commit", next: snapshot, privateRecords: [], result: snapshot };
      },
    );
  },

  *complete(request: CompleteAuthorityTurnRequest): Operation<TerminalCapsule> {
    return yield* runExecutionCommitLoop(
      ExecutionStoreApi.operations,
      request.executionId,
      function* (current) {
        if (!current) {
          throw new TurnAuthorityBoundaryError(`Execution ${request.executionId} is not open`);
        }
        if (current.record.format === "sweatpants.terminal-execution.v1") {
          return { status: "return", result: parseTerminalCapsule(current.record) };
        }
        assertFacts(current.record, request.facts);
        const factsValue: Json = request.facts.map((fact) => ({
          executionId: fact.executionId,
          sessionId: fact.sessionId,
          turnId: fact.turnId,
          sequence: fact.sequence,
          kind: fact.kind,
          payload: fact.payload,
        }));
        const facts = yield* ExecutionStoreApi.operations.putPayload(factsValue);
        const withFrontier: ExecutionTreeSnapshot = {
          ...current.record,
          unpublishedProjection: { throughSequence: request.facts.length, facts },
        };
        const decision = completeRoot(withFrontier, {
          outcome: request.outcome,
          disposition: request.disposition,
          finalRevision: current.revision + 1,
          completedAt: request.completedAt,
        });
        const capsule = decision.next as TerminalCapsule;
        return {
          status: "commit",
          next: capsule,
          privateRecords: decision.privateRecords,
          result: capsule,
        };
      },
    );
  },

  *read(executionId: string): Operation<TerminalCapsule | ExecutionTreeSnapshot | null> {
    const current = yield* ExecutionStoreApi.operations.loadExecution(executionId);
    if (!current) return null;
    return current.record.format === "sweatpants.terminal-execution.v1"
      ? parseTerminalCapsule(current.record)
      : current.record;
  },

  *readAcceptedFacts(capsule: TerminalCapsule): Operation<readonly ProjectionFactEnvelope[]> {
    if (capsule.projection.throughSequence === 0) return [];
    if (!capsule.projection.facts) {
      throw new TurnAuthorityBoundaryError("Terminal Capsule fact frontier has no reference");
    }
    const stored = yield* ExecutionStoreApi.operations.getPayload(capsule.projection.facts);
    if (!Array.isArray(stored)) {
      throw new TurnAuthorityBoundaryError("Accepted Projection Facts payload is unavailable");
    }
    const facts = stored.map(parseFact);
    assertFacts(capsule, facts);
    return facts;
  },

  *markPublished(executionId: string): Operation<TerminalCapsule> {
    return yield* runExecutionCommitLoop(
      ExecutionStoreApi.operations,
      executionId,
      function* (current) {
        if (!current || current.record.format !== "sweatpants.terminal-execution.v1") {
          throw new TurnAuthorityBoundaryError(`Execution ${executionId} is not terminal`);
        }
        const capsule = parseTerminalCapsule(current.record);
        if (capsule.publication === "published") {
          return { status: "return", result: capsule };
        }
        const next: TerminalCapsule = { ...capsule, publication: "published" };
        return { status: "commit", next, privateRecords: [], result: next };
      },
    );
  },
});

function initialSnapshot(request: OpenAuthorityTurnRequest): ExecutionTreeSnapshot {
  return {
    format: "sweatpants.execution-tree.v1",
    executionId: request.executionId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    rootTaskId: request.rootTaskId,
    rootProgram: request.rootProgram,
    tasks: [
      {
        taskId: request.rootTaskId,
        program: request.rootProgram,
        input: { storage: "inline", value: null },
        route: null,
        status: "active",
        actionIndex: 0,
        pullIndex: 0,
        emissionIndex: 0,
        replayHead: null,
        pending: null,
      },
    ],
    runnableTaskIds: [request.rootTaskId],
    checkpoint: null,
    unpublishedProjection: { throughSequence: 0, facts: null },
  };
}

function assertIdentity(
  record: ExecutionTreeSnapshot | TerminalCapsule,
  expected: Pick<OpenAuthorityTurnRequest, "executionId" | "sessionId" | "turnId" | "rootTaskId">,
): void {
  if (
    record.executionId !== expected.executionId ||
    record.sessionId !== expected.sessionId ||
    record.turnId !== expected.turnId ||
    record.rootTaskId !== expected.rootTaskId
  ) {
    throw new TurnAuthorityBoundaryError("Existing execution identity differs from requested Turn");
  }
}

function assertFacts(
  record: Pick<ExecutionTreeSnapshot | TerminalCapsule, "executionId" | "sessionId" | "turnId">,
  facts: readonly ProjectionFactEnvelope[],
): void {
  facts.forEach((fact, index) => {
    if (
      fact.executionId !== record.executionId ||
      fact.sessionId !== record.sessionId ||
      fact.turnId !== record.turnId ||
      fact.sequence !== index + 1
    ) {
      throw new TurnAuthorityBoundaryError(`Projection Fact ${index + 1} has an invalid frontier`);
    }
  });
}

function parseFact(value: unknown): ProjectionFactEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TurnAuthorityBoundaryError("Projection Fact must be an object");
  }
  const fact = value as Record<string, unknown>;
  if (
    typeof fact["executionId"] !== "string" ||
    typeof fact["sessionId"] !== "string" ||
    typeof fact["turnId"] !== "string" ||
    typeof fact["sequence"] !== "number" ||
    !Number.isSafeInteger(fact["sequence"]) ||
    typeof fact["kind"] !== "string" ||
    !("payload" in fact)
  ) {
    throw new TurnAuthorityBoundaryError("Projection Fact fields are invalid");
  }
  return {
    executionId: fact["executionId"],
    sessionId: fact["sessionId"],
    turnId: fact["turnId"],
    sequence: fact["sequence"],
    kind: fact["kind"],
    payload: canonicalSnapshot(fact["payload"] as Json).value,
  };
}
