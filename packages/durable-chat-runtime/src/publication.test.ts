import { canonicalSnapshot } from "@sweatpants/foundation";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import { ConversationStoreApi, installConversationStore } from "@sweatpants/history-store/port";
import type { ConversationHeadProposal } from "@sweatpants/history-store/contract";
import type { TerminalCapsule } from "@sweatpants/durable-execution";
import { ExecutionStoreApi, installExecutionStore } from "@sweatpants/journal-authority/api";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { TurnJournalAuthority } from "@sweatpants/journal-authority/turn-authority";
import {
  beginTurnPublication,
  completeAndPublishTurn,
  ProjectionFactsInvalid,
  publishTurn,
  publicationKey,
  recoverTerminalPublication,
  type ProjectionFactEnvelope,
} from "./index.ts";

type Entry = { readonly turn: string; readonly text: string };

const capsule: TerminalCapsule = {
  type: "terminal",
  format: "sweatpants.terminal-execution.v1",
  executionId: "execution-1",
  sessionId: "session-1",
  turnId: "turn-1",
  rootTaskId: "root",
  rootProgram: { id: "chat", version: "1", digest: "d".repeat(64) },
  outcome: { storage: "inline", value: "TERMINAL_V1" },
  disposition: "completed",
  finalRevision: 4,
  completedAt: 100,
  projection: { throughSequence: 1, facts: null },
  publication: "unpublished",
};

const facts: readonly ProjectionFactEnvelope[] = [
  {
    executionId: "execution-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence: 1,
    kind: "chat.turn_completed",
    payload: { text: "TERMINAL_V1" },
  },
];

const idleProposal: ConversationHeadProposal = {
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

function project(accepted: readonly ProjectionFactEnvelope[]): readonly Entry[] {
  return accepted.map((fact) => ({
    turn: fact.turnId,
    text: String((fact.payload as { text: string }).text),
  }));
}

function beginRequest() {
  return {
    executionId: "execution-1",
    sessionId: "session-1",
    turnId: "turn-1",
    rootTaskId: "root",
    rootProgram: capsule.rootProgram,
    commandId: "command-1",
    commandDigest: "command-digest-1",
    participantId: "test-rig",
    acceptedAt: 1,
    retainUntil: 10_000,
  } as const;
}

function* installConversation(store: ReturnType<typeof createMemoryConversationStore>) {
  yield* installConversationStore(store);
  const initialized = yield* ConversationStoreApi.operations.compareAndSwapHead(
    "session-1",
    null,
    null,
    idleProposal,
  );
  expect(initialized.status).toBe("committed");
}

describe("terminal Turn publication", () => {
  it("writes terminal content before head CAS and publishes once", async () => {
    const conversation = createMemoryConversationStore();
    const marked: string[] = [];
    await run(function* () {
      yield* installConversation(conversation);
      const result = yield* publishTurn({
        capsule,
        *readAcceptedFacts() {
          return facts;
        },
        project,
        *markPublished(pointer) {
          marked.push(pointer.segmentId);
        },
      });
      expect(result).toMatchObject({ status: "published", headRevision: "1" });
      expect(
        (yield* ConversationStoreApi.operations.readTerminalHistoryPage("session-1")).entries,
      ).toEqual([{ turn: "turn-1", text: "TERMINAL_V1" }]);
    });
    expect(marked).toHaveLength(1);
  });

  it("recovers an interrupted publication without duplicating the Turn", async () => {
    const conversation = createMemoryConversationStore();
    const marked: string[] = [];
    const entries = [{ turn: "turn-1", text: "TERMINAL_V1" }];
    await run(function* () {
      yield* installConversation(conversation);
      const key = publicationKey(capsule);
      const encoded = canonicalSnapshot(entries);
      yield* ConversationStoreApi.operations.putTerminalHistorySegment({
        segmentId: key,
        conversationId: "session-1",
        logicalTurnId: "turn-1",
        executionId: "execution-1",
        publicationKey: key,
        previous: null,
        firstPosition: "0",
        lastPosition: "0",
        entries,
        contentHash: encoded.sha,
        createdAt: 100,
      });

      const recovered = yield* publishTurn({
        capsule,
        *readAcceptedFacts() {
          return facts;
        },
        project,
        *markPublished(pointer) {
          marked.push(pointer.segmentId);
        },
      });
      expect(recovered.status).toBe("published");

      const repeated = yield* publishTurn({
        capsule,
        *readAcceptedFacts() {
          return facts;
        },
        project,
        *markPublished(pointer) {
          marked.push(pointer.segmentId);
        },
      });
      expect(repeated.status).toBe("already_published");
      expect(
        (yield* ConversationStoreApi.operations.readTerminalHistoryPage("session-1")).entries,
      ).toEqual(entries);
    });
    expect(marked).toHaveLength(2);
  });

  it("commits terminal authority before publication and repairs terminal-unpublished state", async () => {
    const conversation = createMemoryConversationStore();
    const execution = createMemoryExecutionStore();
    await run(function* () {
      yield* installExecutionStore(execution);
      yield* installConversation(conversation);
      const identity = yield* beginTurnPublication(beginRequest());
      const terminal = yield* TurnJournalAuthority.operations.complete({
        executionId: identity.executionId,
        outcome: capsule.outcome,
        disposition: capsule.disposition,
        completedAt: capsule.completedAt,
        facts,
      });
      expect(terminal.publication).toBe("unpublished");
      expect(
        (yield* ConversationStoreApi.operations.loadHead("session-1"))?.activeExecutionId,
      ).toBe("execution-1");

      const recovered = yield* recoverTerminalPublication("session-1", project);
      expect(recovered?.result.status).toBe("published");
      expect((yield* TurnJournalAuthority.operations.read("execution-1"))?.format).toBe(
        "sweatpants.terminal-execution.v1",
      );
      expect(yield* ConversationStoreApi.operations.loadHead("session-1")).toMatchObject({
        activeExecutionId: null,
        latestCompletedExecutionId: "execution-1",
        state: "idle",
      });
      expect(
        (yield* ConversationStoreApi.operations.readTerminalHistoryPage("session-1")).entries,
      ).toEqual([{ turn: "turn-1", text: "TERMINAL_V1" }]);
    });
  });

  it("repairs an admitted head when authority open fails and retries idempotently", async () => {
    const conversation = createMemoryConversationStore();
    const execution = createMemoryExecutionStore();
    let failOpen = true;
    await run(function* () {
      yield* installExecutionStore(execution);
      yield* installConversation(conversation);
      yield* ExecutionStoreApi.around({
        *commitExecution([request], next) {
          if (failOpen && request.executionId === "execution-1") {
            failOpen = false;
            throw new Error("injected authority open failure");
          }
          return yield* next(request);
        },
      });

      let failure: unknown;
      try {
        yield* beginTurnPublication(beginRequest());
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "injected authority open failure" });
      expect(yield* ConversationStoreApi.operations.loadHead("session-1")).toMatchObject({
        state: "idle",
        activeExecutionId: null,
      });
      expect(
        yield* ConversationStoreApi.operations.getCommandReceipt("session-1", "command-1"),
      ).toMatchObject({ executionId: "execution-1", logicalTurnId: "turn-1" });
      expect(yield* TurnJournalAuthority.operations.read("execution-1")).toBeNull();

      const retried = yield* beginTurnPublication(beginRequest());
      expect(retried.executionId).toBe("execution-1");
      expect(yield* TurnJournalAuthority.operations.read("execution-1")).not.toBeNull();
      expect(yield* ConversationStoreApi.operations.loadHead("session-1")).toMatchObject({
        state: "running",
        activeExecutionId: "execution-1",
      });
    });
  });

  it("completes and publishes normally through both direct stores", async () => {
    const conversation = createMemoryConversationStore();
    const execution = createMemoryExecutionStore();
    await run(function* () {
      yield* installExecutionStore(execution);
      yield* installConversation(conversation);
      yield* beginTurnPublication(beginRequest());
      const result = yield* completeAndPublishTurn({
        executionId: "execution-1",
        outcome: capsule.outcome,
        disposition: "completed",
        completedAt: 100,
        facts,
        project,
      });
      expect(result.status).toBe("published");
      const terminal = yield* TurnJournalAuthority.operations.read("execution-1");
      expect(terminal?.format).toBe("sweatpants.terminal-execution.v1");
    });
  });

  it("joins an active execution for resume without admitting a new send-message", async () => {
    const conversation = createMemoryConversationStore();
    const execution = createMemoryExecutionStore();
    await run(function* () {
      yield* installExecutionStore(execution);
      yield* installConversation(conversation);
      const first = yield* beginTurnPublication(beginRequest());
      const joined = yield* beginTurnPublication({
        ...beginRequest(),
        executionId: "execution-2",
        commandId: "command-2",
        commandDigest: "command-digest-2",
        admission: "join-active",
      });
      expect(joined.executionId).toBe(first.executionId);
      expect((yield* ConversationStoreApi.operations.loadHead("session-1"))?.state).toBe("running");
    });
  });

  it("rejects a second send-message while the conversation is running", async () => {
    const conversation = createMemoryConversationStore();
    const execution = createMemoryExecutionStore();
    let failure: unknown;
    await run(function* () {
      yield* installExecutionStore(execution);
      yield* installConversation(conversation);
      yield* beginTurnPublication(beginRequest());
      try {
        yield* beginTurnPublication({
          ...beginRequest(),
          executionId: "execution-2",
          commandId: "command-2",
          commandDigest: "command-digest-2",
        });
      } catch (error) {
        failure = error;
      }
    });
    expect(String(failure)).toMatch(/is not idle/);
  });

  it("rejects facts outside the capsule's accepted identity and sequence frontier", async () => {
    const conversation = createMemoryConversationStore();
    let failure: unknown;
    await run(function* () {
      yield* installConversation(conversation);
      yield* ConversationStoreApi.operations.compareAndSwapHead(
        "session-1",
        null,
        null,
        idleProposal,
      );
      try {
        yield* publishTurn({
          capsule,
          *readAcceptedFacts() {
            return [{ ...facts[0]!, executionId: "other-execution" }];
          },
          project,
          *markPublished() {},
        });
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toBeInstanceOf(ProjectionFactsInvalid);
  });
});
