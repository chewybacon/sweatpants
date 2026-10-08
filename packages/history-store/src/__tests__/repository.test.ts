import { canonicalDigest, canonicalJson } from "@sweatpants/foundation";
import { createMemoryDurableKernel } from "@sweatpants/durable-storage-kernel/memory";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryConversationStore } from "../memory.ts";
import type {
  CommandAdmissionRequest,
  ConversationHeadProposal,
  StoredCheckpoint,
} from "../contract.ts";
import { checkpointPayloadFromHotRoots } from "../checkpoint-payload.ts";
import { createKernelConversationStore } from "../repository.ts";

const idle: ConversationHeadProposal = {
  state: "idle",
  checkpoint: null,
  terminalHistory: null,
  activeLogicalTurnId: null,
  activeExecutionId: null,
  latestCompletedExecutionId: null,
  activeSegment: null,
  activeCommand: null,
  deletedAt: null,
  ownerTransition: { kind: "clear" },
};

describe("kernel conversation repository", () => {
  it("plans against an observed head but still rejects a peer commit atomically", async () => {
    const kernel = createMemoryDurableKernel();
    let reads = 0;
    const store = createKernelConversationStore({
      ...kernel,
      *readAuthority(collection, key) {
        reads++;
        return yield* kernel.readAuthority(collection, key);
      },
    });
    const peer = createKernelConversationStore(kernel);
    await run(function* () {
      yield* store.compareAndSwapHead("conversation", null, null, idle);
      const basis = yield* store.loadHead("conversation");
      const before = reads;
      expect(
        yield* store.compareAndSwapHead("conversation", basis!.revision, basis!.ownerEpoch, idle),
      ).toMatchObject({ status: "committed", head: { revision: "1" } });
      expect(reads).toBe(before);
      yield* peer.compareAndSwapHead("conversation", "1", "0", idle);
      const candidate = checkpoint("losing", "lineage");
      expect(
        yield* store.commitConversation({
          conversationId: "conversation",
          expectedRevision: "1",
          expectedOwnerEpoch: "0",
          proposal: { ...idle, checkpoint: { checkpointId: candidate.checkpointId } },
          checkpoint: candidate,
        }),
      ).toMatchObject({ status: "head_conflict", current: { revision: "2" } });
      expect(yield* store.getCheckpoint({ checkpointId: candidate.checkpointId })).toBeNull();
      expect(yield* store.loadHead("conversation")).toMatchObject({ revision: "2" });
      expect(reads).toBe(before + 1);
    });
  });

  it("retains immutable checkpoints without caching misses or caller mutations", async () => {
    const kernel = createMemoryDurableKernel();
    let reads = 0;
    const store = createKernelConversationStore({
      ...kernel,
      *readImmutable(collection, key) {
        reads++;
        return yield* kernel.readImmutable(collection, key);
      },
    });
    const accepted = checkpoint("owned", "lineage");
    const pointer = { checkpointId: accepted.checkpointId };
    await run(function* () {
      expect(yield* store.getCheckpoint(pointer)).toBeNull();
      yield* store.putCheckpoint(accepted);
      const first = yield* store.getCheckpoint(pointer);
      const readsAfterFirst = reads;
      Object.assign(first!, { payload: null });
      expect(yield* store.getCheckpoint(pointer)).toEqual(accepted);
      expect(reads).toBe(readsAfterFirst);
      const restored = createKernelConversationStore(kernel);
      expect(yield* restored.getCheckpoint(pointer)).toEqual(accepted);
    });
  });

  it("preserves idempotent command retries and reports identity evidence on divergence", async () => {
    const store = createMemoryConversationStore();
    await run(function* () {
      expect(yield* store.compareAndSwapHead("conversation", null, null, idle)).toMatchObject({
        status: "committed",
        head: { revision: "0" },
      });

      const request = commandRequest();
      const admitted = yield* store.admitCommand(request);
      expect(admitted).toMatchObject({
        status: "admitted",
        receipt: { commandDigest: "digest-1" },
      });
      if (admitted.status !== "admitted") throw new Error("command was not admitted");

      const retried = yield* store.admitCommand(request);
      expect(retried).toMatchObject({
        status: "idempotent",
        receipt: admitted.receipt,
      });

      expect(yield* store.admitCommand(commandRequest("digest-2"))).toEqual({
        status: "command_identity_conflict",
        receipt: admitted.receipt,
        conflict: {
          domain: "conversation-command",
          key: "conversation/command-1",
          guard: "identity",
          expected: "digest-2",
          observed: "digest-1",
        },
      });
    });
  });

  it("publishes terminal content and the selecting head in one semantic commit", async () => {
    const store = createMemoryConversationStore();
    await run(function* () {
      const initial = yield* store.compareAndSwapHead("conversation", null, null, idle);
      expect(initial.status).toBe("committed");
      const entries = [{ event: "complete" }];
      const segment = {
        segmentId: "terminal-1",
        conversationId: "conversation",
        logicalTurnId: "turn-1",
        executionId: "execution-1",
        publicationKey: "turn-1",
        previous: null,
        firstPosition: "0",
        lastPosition: "0",
        entries,
        contentHash: canonicalDigest(entries),
        createdAt: 2,
      } as const;
      const committed = yield* store.commitConversation({
        conversationId: "conversation",
        expectedRevision: "0",
        expectedOwnerEpoch: "0",
        terminalHistorySegment: segment,
        proposal: {
          ...idle,
          terminalHistory: { segmentId: segment.segmentId, lastPosition: "0" },
          latestCompletedExecutionId: segment.executionId,
        },
        updatedAt: 3,
      });
      expect(committed).toMatchObject({
        status: "committed",
        head: { revision: "1", terminalHistory: { segmentId: "terminal-1" } },
      });
      expect(yield* store.readTerminalHistoryPage("conversation")).toMatchObject({
        entries,
        head: { segmentId: "terminal-1" },
      });
    });
  });

  it("selects the persisted checkpoint identity when retrying an already staged cause", async () => {
    const store = createMemoryConversationStore();
    const accepted = checkpoint("accepted-id", "original-lineage");
    const retry = checkpoint("new-attempt-id", "new-attempt-lineage");
    await run(function* () {
      yield* store.compareAndSwapHead("conversation", null, null, idle);
      yield* store.putCheckpoint(accepted);
      const committed = yield* store.commitConversation({
        conversationId: "conversation",
        expectedRevision: "0",
        expectedOwnerEpoch: "0",
        checkpoint: retry,
        proposal: { ...idle, checkpoint: { checkpointId: retry.checkpointId } },
      });
      expect(committed).toMatchObject({
        status: "committed",
        checkpoint: { checkpointId: accepted.checkpointId },
        head: { revision: "1", checkpoint: { checkpointId: accepted.checkpointId } },
      });
      expect(yield* store.getCheckpoint({ checkpointId: accepted.checkpointId })).toEqual(accepted);
      expect(yield* store.getCheckpoint({ checkpointId: retry.checkpointId })).toBeNull();

      const changed = checkpoint("changed-attempt-id", "new-attempt-lineage", "changed");
      let conflict: unknown;
      try {
        yield* store.commitConversation({
          conversationId: "conversation",
          expectedRevision: "1",
          expectedOwnerEpoch: "0",
          checkpoint: changed,
          proposal: { ...idle, checkpoint: { checkpointId: changed.checkpointId } },
        });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toMatchObject({ code: "immutable_object_conflict" });
      expect(yield* store.loadHead("conversation")).toMatchObject({
        revision: "1",
        checkpoint: { checkpointId: accepted.checkpointId },
      });
    });
  });

  it("retains the original head CAS when another writer wins during checkpoint reconciliation", async () => {
    const kernel = createMemoryDurableKernel();
    const competitor = createKernelConversationStore(kernel);
    let raced = false;
    const store = createKernelConversationStore({
      ...kernel,
      *apply(mutation) {
        const outcome = yield* kernel.apply(mutation);
        if (!raced && outcome.status === "immutable_conflict" && outcome.write === "checkpoint") {
          raced = true;
          yield* competitor.compareAndSwapHead("conversation", "0", "0", idle);
        }
        return outcome;
      },
    });
    const accepted = checkpoint("accepted-id", "original-lineage");
    const retry = checkpoint("new-attempt-id", "new-attempt-lineage");
    await run(function* () {
      yield* store.compareAndSwapHead("conversation", null, null, idle);
      yield* store.putCheckpoint(accepted);
      const committed = yield* store.commitConversation({
        conversationId: "conversation",
        expectedRevision: "0",
        expectedOwnerEpoch: "0",
        checkpoint: retry,
        proposal: { ...idle, checkpoint: { checkpointId: retry.checkpointId } },
      });
      expect(raced).toBe(true);
      expect(committed).toMatchObject({
        status: "head_conflict",
        current: { revision: "1", checkpoint: null },
      });
      expect(yield* store.getCheckpoint({ checkpointId: retry.checkpointId })).toBeNull();
      expect(yield* store.loadHead("conversation")).toMatchObject({
        revision: "1",
        checkpoint: null,
      });
    });
  });
});

function checkpoint(
  checkpointId: string,
  lineageId: string,
  marker = "original",
): StoredCheckpoint {
  const payload = checkpointPayloadFromHotRoots([], { marker });
  return {
    checkpointId,
    conversationId: "conversation",
    lineageId,
    causeKey: "same-cause",
    cause: { kind: "test" },
    contentHash: canonicalDigest(payload),
    archiveHead: null,
    archiveFrontierOrdinal: "0",
    nextPublicPosition: "0",
    payload,
    encodedBytes: new TextEncoder().encode(canonicalJson(payload)).byteLength,
    createdAt: 1,
  };
}

function commandRequest(commandDigest = "digest-1"): CommandAdmissionRequest {
  return {
    conversationId: "conversation",
    commandId: "command-1",
    commandDigest,
    participantId: "participant-1",
    acceptedAt: 1,
    retainUntil: 100,
    expectedRevision: "0",
    requiredState: "idle",
    logicalTurnId: "turn-1",
    executionId: "execution-1",
    proposal: {
      ...idle,
      state: "running",
      activeLogicalTurnId: "turn-1",
      activeExecutionId: "execution-1",
      activeCommand: {
        kind: "send-message",
        commandId: "command-1",
        logicalTurnId: "turn-1",
        executionId: "execution-1",
      },
      ownerTransition: {
        kind: "assign",
        ownerRoute: { executionId: "execution-1", taskId: "task-1" },
      },
    },
  };
}
