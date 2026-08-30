import {
  assertJson,
  canonicalSnapshot,
  sha256,
  stableTupleHash,
  type Json,
} from "@sweatpants/foundation";
import {
  completeRoot,
  terminalCapsuleParser,
  type ExecutionTreeSnapshot,
  type ProgramIdentity,
  type ProjectionFactEnvelope,
  type StoredJson,
  type TerminalCapsule,
} from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import { createApi } from "effection/experimental";
import { ExecutionStoreApi } from "../api.ts";
import { AcceptedProjectionFactStore } from "../store/fact-store.ts";
import { inlineControl, runExecutionCommitLoop } from "../store/commit-loop.ts";
import {
  DEFAULT_PRIVATE_SEGMENT_TARGET,
  segmentPrivateEntries,
  type PrivateSegmentTarget,
} from "../store/segmentation.ts";
import type {
  ExecutionControl,
  PrivateSegmentPointer,
  StoredPrivateSegment,
} from "../store/store.ts";
import { ExecutionStoreError } from "../store/store.ts";

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

const TURN_CONTROL_KIND = "turn-control";

interface TurnControlPayload {
  readonly kind: typeof TURN_CONTROL_KIND;
  readonly recordObjectId: string;
  readonly journalHead: PrivateSegmentPointer | null;
}

export const TurnJournalAuthority = createApi("turn-journal-authority", {
  *open(request: OpenAuthorityTurnRequest): Operation<ExecutionTreeSnapshot | TerminalCapsule> {
    return yield* runExecutionCommitLoop(
      ExecutionStoreApi.operations,
      request.executionId,
      function* (current) {
        if (current) {
          const record = yield* loadRecord(current);
          assertIdentity(record, request);
          return { status: "return", result: record };
        }
        const snapshot = initialSnapshot(request);
        return {
          status: "commit",
          next: yield* controlForRecord(snapshot, "0", null),
          result: snapshot,
        };
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
        const parsed = parseTurnControl(current.control);
        const record = yield* loadRecord(current);
        if (record.format === "sweatpants.terminal-execution.v1") {
          return { status: "return", result: requireTerminalCapsule(record) };
        }
        assertFacts(record, request.facts);
        const facts = yield* AcceptedProjectionFactStore.operations.put({
          executionId: request.executionId,
          facts: request.facts,
        });
        const withFrontier: ExecutionTreeSnapshot = {
          ...record,
          unpublishedProjection: { throughSequence: request.facts.length, facts },
        };
        const decision = completeRoot(withFrontier, {
          outcome: request.outcome,
          disposition: request.disposition,
          finalRevision: capsuleRevision(current.controlRevision),
          completedAt: request.completedAt,
        });
        const capsule = decision.next as TerminalCapsule;
        const journalSegments = privateSegments(
          request.executionId,
          "authority",
          parsed.journalHead,
          decision.privateRecords,
          request.completedAt,
        );
        const journalHead =
          journalSegments.at(-1) === undefined
            ? parsed.journalHead
            : {
                segmentId: journalSegments.at(-1)!.segmentId,
                lastSequence: journalSegments.at(-1)!.lastSequence,
              };
        return {
          status: "commit",
          next: yield* controlForRecord(capsule, current.ownerFence, journalHead),
          ...(journalSegments.length > 0 ? { journalSegments } : {}),
          result: capsule,
        };
      },
    );
  },

  *read(executionId: string): Operation<TerminalCapsule | ExecutionTreeSnapshot | null> {
    const current = yield* ExecutionStoreApi.operations.loadControl(executionId);
    if (!current) return null;
    const record = yield* loadRecord(current);
    return record.format === "sweatpants.terminal-execution.v1"
      ? requireTerminalCapsule(record)
      : record;
  },

  *readAcceptedFacts(capsule: TerminalCapsule): Operation<readonly ProjectionFactEnvelope[]> {
    if (capsule.projection.throughSequence === 0) return [];
    if (!capsule.projection.facts) {
      throw new TurnAuthorityBoundaryError("Terminal Capsule fact frontier has no reference");
    }
    const facts = yield* AcceptedProjectionFactStore.operations.read({
      executionId: capsule.executionId,
      frontier: capsule.projection,
    });
    assertFacts(capsule, facts);
    return facts;
  },

  *markPublished(executionId: string): Operation<TerminalCapsule> {
    return yield* runExecutionCommitLoop(
      ExecutionStoreApi.operations,
      executionId,
      function* (current) {
        if (!current) {
          throw new TurnAuthorityBoundaryError(`Execution ${executionId} is not terminal`);
        }
        const parsed = parseTurnControl(current.control);
        const capsule = requireTerminalCapsule(yield* loadRecord(current));
        if (capsule.publication === "published") {
          return { status: "return", result: capsule };
        }
        const next: TerminalCapsule = { ...capsule, publication: "published" };
        return {
          status: "commit",
          next: yield* controlForRecord(next, current.ownerFence, parsed.journalHead),
          result: next,
        };
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

function parseTurnControl(value: Json): TurnControlPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TurnAuthorityBoundaryError("Turn control payload is invalid");
  }
  if (value["kind"] !== TURN_CONTROL_KIND || typeof value["recordObjectId"] !== "string") {
    throw new TurnAuthorityBoundaryError("Turn control payload is invalid");
  }
  return {
    kind: TURN_CONTROL_KIND,
    recordObjectId: value["recordObjectId"],
    journalHead: parsePrivatePointer(value["journalHead"]),
  };
}

function parsePrivatePointer(value: unknown): PrivateSegmentPointer | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)["segmentId"] !== "string" ||
    typeof (value as Record<string, unknown>)["lastSequence"] !== "string"
  ) {
    throw new TurnAuthorityBoundaryError("Turn journal pointer is invalid");
  }
  return {
    segmentId: (value as Record<string, string>)["segmentId"]!,
    lastSequence: (value as Record<string, string>)["lastSequence"]!,
  };
}

function* loadRecord(
  control: ExecutionControl,
): Operation<ExecutionTreeSnapshot | TerminalCapsule> {
  const parsed = parseTurnControl(control.control);
  const object = yield* ExecutionStoreApi.operations.getObject({ objectId: parsed.recordObjectId });
  if (!object || object.body instanceof Uint8Array) {
    throw new TurnAuthorityBoundaryError(`Execution ${control.executionId} record is unavailable`);
  }
  if (object.lifetimeScope === "execution" && object.scopeOwnerId !== control.executionId) {
    throw new TurnAuthorityBoundaryError(
      `Execution ${control.executionId} record is outside scope`,
    );
  }
  return parseStoredRecord(object.body, control.executionId);
}

function parseStoredRecord(
  value: Json,
  executionId: string,
): ExecutionTreeSnapshot | TerminalCapsule {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value["format"] === "sweatpants.execution-tree.v1"
  ) {
    return value as unknown as ExecutionTreeSnapshot;
  }
  const parsed = terminalCapsuleParser.parse(value);
  if (parsed.ok) return parsed.value;
  throw new TurnAuthorityBoundaryError(`Execution ${executionId} control record is invalid`);
}

function* controlForRecord(
  record: ExecutionTreeSnapshot | TerminalCapsule,
  ownerFence: string,
  journalHead: PrivateSegmentPointer | null,
): Operation<Omit<ExecutionControl, "controlRevision" | "updatedAt">> {
  const stored = yield* putExecutionObject(
    record.executionId,
    "turn-record",
    record as unknown as Json,
  );
  const terminal = record.format === "sweatpants.terminal-execution.v1";
  return inlineControl(
    record.executionId,
    record.rootTaskId,
    terminal
      ? "terminal"
      : record.tasks.some((task) => task.status === "parked")
        ? "parked"
        : "active",
    assertJson({
      kind: TURN_CONTROL_KIND,
      recordObjectId: stored.id,
      journalHead,
    }),
    ownerFence,
  );
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

function requireTerminalCapsule(value: ExecutionTreeSnapshot | TerminalCapsule): TerminalCapsule {
  const parsed = terminalCapsuleParser.parse(value);
  if (!parsed.ok) throw new TurnAuthorityBoundaryError("Stored Terminal Capsule is invalid");
  return parsed.value;
}

function capsuleRevision(controlRevision: string): number {
  if (!/^\d+$/.test(controlRevision)) {
    throw new TurnAuthorityBoundaryError(`Invalid control revision ${controlRevision}`);
  }
  const next = BigInt(controlRevision) + 1n;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TurnAuthorityBoundaryError(
      "Execution control revision exceeds capsule revision range",
    );
  }
  return Number(next);
}

function* putExecutionObject(
  executionId: string,
  kind: string,
  body: Json,
): Operation<{
  id: string;
  byteLength: number;
  version: string;
  integrity: { algorithm: "sha256"; value: string };
}> {
  const encoded = canonicalSnapshot(body);
  const objectId = stableTupleHash([executionId, kind, encoded.sha]);
  const byteLength = new TextEncoder().encode(encoded.canonical).byteLength;
  yield* ExecutionStoreApi.operations.putObject({
    objectId,
    lifetimeScope: "execution",
    scopeOwnerId: executionId,
    objectKind: kind,
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
}

function privateSegments(
  executionId: string,
  taskId: string,
  previous: PrivateSegmentPointer | null,
  entries: readonly Json[],
  createdAt: number,
  target: PrivateSegmentTarget = DEFAULT_PRIVATE_SEGMENT_TARGET,
): StoredPrivateSegment[] {
  if (entries.length === 0) return [];
  const segments: StoredPrivateSegment[] = [];
  let cursor = previous;
  for (const batch of segmentPrivateEntries(entries, target)) {
    const first = cursor === null ? 1n : BigInt(cursor.lastSequence) + 1n;
    const last = first + BigInt(batch.entries.length - 1);
    const encoded = canonicalSnapshot(batch.entries);
    const contentHash = sha256(encoded.canonical);
    const segment: StoredPrivateSegment = {
      segmentId: stableTupleHash([executionId, taskId, first.toString(10), contentHash]),
      executionId,
      taskId,
      previous: cursor,
      firstSequence: first.toString(10),
      lastSequence: last.toString(10),
      entries: batch.entries,
      contentHash,
      encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
      createdAt,
    };
    segments.push(segment);
    cursor = { segmentId: segment.segmentId, lastSequence: segment.lastSequence };
  }
  return segments;
}

export { ExecutionStoreError };
