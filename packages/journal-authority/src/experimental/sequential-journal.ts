/** Experimental successful, repeatable records only. Not installed by the host. */
import type { Operation } from "effection";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import {
  assertProgramReplayFrontier,
  verifyProgramReplayEntry,
  type AttachProgramRequest,
  type DurableOperationDescriptor,
  programRouteDriverKind,
  type RecordedOperationDescriptor,
  type ReplayItem,
} from "@sweatpants/durable-execution";
import { assertJson, canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import type { BindMandateRequest, RecoverRecordResult } from "../contract/authority-types.ts";
import type { JournalAuthorityContract } from "../contract/authority-contract.ts";

export type Outcome = OperationOutcome;
export type Computation = () => Generator<DurableOperationDescriptor, Json, Json>;
export type Handler = (request: RecordedOperationDescriptor) => Operation<Outcome>;

type Turn =
  | { type: "operation"; actionIndex: number; descriptor: RecordedOperationDescriptor }
  | { type: "completed"; actionIndex: number; value: Json };

function advance(iterator: ReturnType<Computation>, actionIndex: number, value: Json = null): Turn {
  const next = iterator.next(value);
  if (next.done) {
    assertJson(next.value);
    return { type: "completed", actionIndex, value: next.value };
  }
  if (next.value.kind !== "record" || next.value.retrySafety.mode !== "repeatable") {
    throw new Error("Experimental journal supports only repeatable records");
  }
  return { type: "operation", actionIndex, descriptor: structuredClone(next.value) };
}

/** No handler capability exists during replay. Validate the entire chain before delivery. */
function reconstruct(work: Computation, item: ReplayItem) {
  if (item.checkpoint) {
    throw new Error("Experimental journal does not support continuation checkpoints");
  }
  const seed = sha256(
    canonicalJson({
      domain: "sweatpants.forest-replay.v2",
      address: item.address,
      strand: item.strand,
      program: item.program,
    }),
  );
  if (seed !== item.replayChainSeed) {
    throw new Error("Experimental replay identity mismatch");
  }
  let chain = item.replayChainSeed;
  for (const [index, entry] of item.replay.entries()) {
    verifyProgramReplayEntry(item.replayChainSeed, entry, chain);
    if (
      entry.actionIndex !== index ||
      entry.type !== "operation" ||
      entry.descriptorKind !== "record" ||
      entry.outcome.status !== "ok"
    ) {
      throw new Error("Experimental journal supports only sequential successful records");
    }
    chain = entry.entryDigest;
  }
  const through = item.replay.length - 1;
  if (
    chain !== item.replayChainDigest ||
    through !== item.replayedThroughActionIndex ||
    through !== item.plannedHead.actionIndex
  ) {
    throw new Error("Experimental replay head mismatch");
  }
  const iterator = work();
  let turn = advance(iterator, 0);
  for (const entry of item.replay) {
    assertProgramReplayFrontier(turn, entry);
    if (entry.type !== "operation" || entry.outcome.status !== "ok") {
      throw new Error("Unsupported accepted outcome");
    }
    turn = advance(iterator, entry.actionIndex + 1, entry.outcome.value);
  }
  return turn;
}

/** Owns reconstruction, bind, dispatch, acceptance and re-planning; never uses ProgramDriver. */
export function* driveSequentialJournal(request: {
  authority: JournalAuthorityContract;
  attach: AttachProgramRequest;
  work: Computation;
  handler: Handler;
  /** Trusted host opt-in: may recover unknown repeatable records after lease release/expiry. */
  recoverPending?: boolean;
  /** Trusted interruption seam receives only an occurrence number, never mutable accepted data. */
  afterAccepted?: (actionIndex: number) => void;
}): Operation<Json> {
  const { authority, attach } = request;
  if (programRouteDriverKind(attach.route) !== "program" || attach.affinity !== undefined) {
    throw new Error("Experimental journal supports only local program placement without affinity");
  }
  for (;;) {
    const cancellation = yield* authority.query({
      type: "task.cancellation-state",
      sessionId: attach.sessionId,
      taskId: attach.taskId,
    });
    if (cancellation.type !== "none") {
      throw new Error("Experimental journal does not support cancellation");
    }
    const plan = yield* authority.query({
      type: "forest.replay-plan",
      sessionId: attach.sessionId,
    });
    const row = plan.rows.find((candidate) => candidate.address.taskId === attach.taskId);
    if (
      plan.rows.length !== 1 ||
      !row ||
      row.groupContext.groupId ||
      row.groupContext.parentTaskId
    ) {
      throw new Error("Experimental journal requires one root strand");
    }
    const input = yield* authority.query({
      type: "task.input",
      sessionId: attach.sessionId,
      taskId: attach.taskId,
    });
    if (
      canonicalJson(row.program) !== canonicalJson(attach.program) ||
      canonicalJson(input) !== canonicalJson(attach.input)
    ) {
      throw new Error("Experimental program/input identity mismatch");
    }
    if (row.classification === "terminal") {
      const terminal = yield* authority.query({
        type: "task.recovery-state",
        sessionId: attach.sessionId,
        taskId: attach.taskId,
      });
      if (terminal.status !== "terminal" || terminal.outcome.status !== "ok") {
        throw new Error("Experimental journal supports only successful completion");
      }
      return terminal.outcome.value;
    }
    const observation =
      request.recoverPending && row.parked
        ? yield* authority.query({
            type: "task.record-recovery-observation",
            sessionId: attach.sessionId,
            taskId: attach.taskId,
          })
        : undefined;
    const item =
      observation?.item ??
      plan.replay.find((candidate) => candidate.address.taskId === attach.taskId);
    if (!item || (!observation && row.classification !== "replayable")) {
      throw new Error("Experimental journal requires a replayable local strand");
    }
    if (
      canonicalJson(item.address) !== canonicalJson(row.address) ||
      item.strand !== row.strand ||
      canonicalJson(item.plannedHead) !== canonicalJson(row.head) ||
      canonicalJson(item.groupContext) !== canonicalJson(row.groupContext) ||
      programRouteDriverKind(item.route) !== "program" ||
      canonicalJson(item.route) !== canonicalJson(attach.route) ||
      canonicalJson(item.program) !== canonicalJson(attach.program) ||
      canonicalJson(item.input) !== canonicalJson(attach.input)
    ) {
      throw new Error("Experimental program/input identity mismatch");
    }
    const turn = reconstruct(request.work, item);
    if (
      observation &&
      (turn.type !== "operation" ||
        turn.actionIndex !== observation.pending.actionIndex ||
        canonicalJson(turn.descriptor) !== canonicalJson(observation.pending.descriptor) ||
        observation.pending.pullId !== row.parked?.pullId)
    ) {
      throw new Error("Experimental pending occurrence differs from guest frontier");
    }
    const frontierDigest = sha256(
      canonicalJson({
        domain: "sweatpants.caught-up-frontier.v1",
        strandHeadDigest: item.plannedHead.digest,
        replayChainDigest: item.replayChainDigest,
        frontier: turn,
      }),
    );
    const replacement: BindMandateRequest = {
      address: item.address,
      strand: item.strand,
      program: item.program,
      attachmentId: `experimental:${crypto.randomUUID()}`,
      ownerId: "experimental-sequential",
      leaseDurationMs: 30000,
      placement: {
        route: { kind: "local", driverKind: "program", route: attach.route },
        evaluatorKind: "program",
        sandbox: { mode: "allocate" },
      },
      expected: {
        strandHeadDigest: item.plannedHead.digest,
        leaseEpoch: item.executionEpoch,
        forkGroupRevision: item.groupContext.groupRevision,
      },
      frontierProof: {
        frontierDigest,
        strandHeadDigest: item.plannedHead.digest,
        replayedThroughActionIndex: item.replayedThroughActionIndex,
        replayChainDigest: item.replayChainDigest,
        cancellationReplayed: false,
      },
    };
    let recovered: RecoverRecordResult | undefined;
    let mandate;
    if (observation) {
      // Administrative host binding to the observed CURRENT attachment, never replacement.
      // A stale epoch rejects; only recover-record rotates ownership and grants dispatch.
      const current = yield* authority.command({
        type: "execution.bind-attachment",
        request: {
          sessionId: attach.sessionId,
          taskId: attach.taskId,
          attachmentId: observation.attachmentId,
          executionEpoch: item.executionEpoch,
        },
      });
      recovered = yield* authority.command({
        type: "execution.recover-record",
        request: {
          ...item.address,
          ...observation.pending,
          programCapability: current.programCapability,
          replacement,
        },
      });
      mandate = recovered.mandate;
    } else {
      const bound = yield* authority.command({
        type: "execution.bind-mandate",
        request: replacement,
      });
      if (bound.status !== "bound") {
        throw new Error("Experimental stale mandate");
      }
      mandate = bound.mandate;
    }
    try {
      if (turn.type === "completed") {
        const closed = yield* authority.command({
          type: "execution.mandate-complete",
          request: { mandate, outcome: { status: "ok", value: turn.value } },
        });
        if (closed.status === "rejected") {
          throw new Error(closed.code);
        }
        return turn.value;
      }
      const reservation =
        recovered ??
        (yield* authority.command({
          type: "execution.mandate-reserve",
          request: { mandate, descriptor: turn.descriptor },
        }));
      if (reservation.status !== "authorized") {
        throw new Error("Experimental journal cannot park");
      }
      const outcome = yield* request.handler(structuredClone(turn.descriptor));
      if (outcome.status !== "ok") {
        throw new Error("Experimental journal supports only successful outcomes");
      }
      const accepted = yield* authority.command({
        type: "execution.resolve-pull",
        request: {
          capability: reservation.resolutionCapability,
          audience: "program-execution",
          outcome,
        },
      });
      if (accepted.status === "rejected") {
        throw new Error(accepted.code);
      }
    } catch (error) {
      try {
        yield* authority.command({
          type: "execution.release-mandate",
          request: { mandate, reason: "failed" },
        });
      } catch {
        // Preserve the activation error if storage fails or the lease already ended.
      }
      throw error;
    }
    request.afterAccepted?.(turn.actionIndex);
    // Never feed the handler answer. A fresh guest consumes only the next authority replay plan.
  }
}
