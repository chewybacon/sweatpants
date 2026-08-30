import {
  DurableCollections,
  type DurableMutation,
  type ImmutableEnsure,
  type StoredAuthorityRecord,
} from "@sweatpants/durable-storage-kernel";
import type {
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionControl,
  StoredPrivateSegment,
} from "./store.ts";
import {
  decodeAuthorityControl,
  encodeExecutionControl,
  encodePrivateSegment,
  executionKeys,
} from "./store-persistence.ts";

export type ExecutionPlan<Result> =
  | { readonly kind: "complete"; readonly result: Result }
  | { readonly kind: "apply"; readonly mutation: DurableMutation };

function counter(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${field} is not a durable counter`);
  }
  return BigInt(value);
}

function next(value: string): string {
  return (counter(value, "counter") + 1n).toString(10);
}

export function privateSegmentEnsure(
  kind: "journal" | "replay",
  segment: StoredPrivateSegment,
  index: number | string = segment.segmentId,
): ImmutableEnsure {
  return {
    name: `${kind}-${index}`,
    collection:
      kind === "journal"
        ? DurableCollections.executionJournalSegments
        : DurableCollections.executionReplaySegments,
    key: executionKeys.segment(segment.segmentId),
    alternateKeys: [
      executionKeys.taskRange(
        segment.executionId,
        segment.taskId,
        segment.firstSequence,
        segment.lastSequence,
      ),
    ],
    fingerprint: segment.contentHash,
    value: encodePrivateSegment(segment),
  };
}

export function planExecutionCommit(input: {
  readonly request: CommitExecutionRequest;
  readonly currentRecord: StoredAuthorityRecord | null;
}): ExecutionPlan<CommitExecutionResult> {
  const { request } = input;
  const current = input.currentRecord === null ? null : decodeAuthorityControl(input.currentRecord);
  if (current === null) {
    if (request.expectedControlRevision !== null || request.expectedOwnerFence !== "0") {
      return { kind: "complete", result: { status: "control_conflict", current: null } };
    }
  } else {
    if (current.ownerFence !== request.expectedOwnerFence) {
      return { kind: "complete", result: { status: "stale_owner", current } };
    }
    if (current.controlRevision !== request.expectedControlRevision) {
      return { kind: "complete", result: { status: "control_conflict", current } };
    }
  }
  if (request.nextControl.executionId !== request.executionId) {
    throw new Error("next execution control must retain executionId");
  }
  counter(request.nextControl.ownerFence, "next owner fence");
  counter(request.nextControl.stopGeneration, "next stop generation");
  if (!Number.isSafeInteger(request.updatedAt) || request.updatedAt < 0) {
    throw new Error("execution updatedAt must be a non-negative safe integer");
  }
  for (const segment of [...(request.journalSegments ?? []), ...(request.replaySegments ?? [])]) {
    if (segment.executionId !== request.executionId) {
      throw new Error("private segment is outside the committed execution");
    }
  }
  const control: ExecutionControl = {
    ...structuredClone(request.nextControl),
    controlRevision: current === null ? "0" : next(current.controlRevision),
    updatedAt: request.updatedAt,
  };
  const ensures = [
    ...(request.journalSegments ?? []).map((segment, index) =>
      privateSegmentEnsure("journal", segment, index),
    ),
    ...(request.replaySegments ?? []).map((segment, index) =>
      privateSegmentEnsure("replay", segment, index),
    ),
  ];
  return {
    kind: "apply",
    mutation: {
      ensures,
      authority: {
        name: "execution-control",
        collection: DurableCollections.executionControls,
        key: executionKeys.control(request.executionId),
        expected: {
          revision: request.expectedControlRevision,
          fence: request.expectedOwnerFence,
        },
        next: {
          revision: control.controlRevision,
          fence: control.ownerFence,
          value: encodeExecutionControl(control),
        },
      },
    },
  };
}
