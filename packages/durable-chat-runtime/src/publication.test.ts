import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryHistoryStore } from "@sweatpants/history-store/memory";
import { HistoryStoreApi, installHistoryStore } from "@sweatpants/history-store/port";
import type { TerminalCapsule } from "@sweatpants/durable-execution";
import { installExecutionStore } from "@sweatpants/journal-authority/api";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { TurnJournalAuthority } from "@sweatpants/journal-authority/turn-authority";
import {
  beginTurnPublication,
  completeAndPublishTurn,
  ProjectionFactsInvalid,
  publishTurn,
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

function project(accepted: readonly ProjectionFactEnvelope[]): readonly Entry[] {
  return accepted.map((fact) => ({
    turn: fact.turnId,
    text: String((fact.payload as { text: string }).text),
  }));
}

describe("terminal Turn publication", () => {
  it("writes history content before head CAS and publishes once", async () => {
    const history = createMemoryHistoryStore<Entry>();
    const marked: string[] = [];
    await run(function* () {
      yield* installHistoryStore(history);
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
      expect(result).toMatchObject({ status: "published", headRevision: 0 });
      expect((yield* HistoryStoreApi.operations.readPage("session-1")).entries).toEqual([
        { turn: "turn-1", text: "TERMINAL_V1" },
      ]);
    });
    expect(marked).toHaveLength(1);
  });

  it("recovers an interrupted publication without duplicating the Turn", async () => {
    const history = createMemoryHistoryStore<Entry>();
    const marked: string[] = [];
    await run(function* () {
      yield* installHistoryStore(history);
      // Fault after immutable content exists but before Session Head advances.
      yield* HistoryStoreApi.operations.putSegment({
        segmentId: "session-1\u0000turn-1\u0000genesis",
        publicationKey: "session-1\u0000turn-1\u0000genesis",
        sessionId: "session-1",
        previous: null,
        firstPosition: 0,
        lastPosition: 0,
        entries: [{ turn: "turn-1", text: "TERMINAL_V1" }],
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
      expect((yield* HistoryStoreApi.operations.readPage("session-1")).entries).toEqual([
        { turn: "turn-1", text: "TERMINAL_V1" },
      ]);
    });
    expect(marked).toHaveLength(2);
  });

  it("commits terminal authority before publication and repairs terminal-unpublished state without rerunning work", async () => {
    const history = createMemoryHistoryStore<Entry>();
    const execution = createMemoryExecutionStore();
    const invocations = { provider: 1, tool: 1, child: 1 };
    await run(function* () {
      yield* installExecutionStore(execution);
      yield* installHistoryStore(history);
      const identity = yield* beginTurnPublication({
        executionId: "execution-1",
        sessionId: "session-1",
        turnId: "turn-1",
        rootTaskId: "root",
        rootProgram: capsule.rootProgram,
      });

      // Semantic fault: terminal capsule is accepted, publication has not run.
      const terminal = yield* TurnJournalAuthority.operations.complete({
        executionId: identity.executionId,
        outcome: capsule.outcome,
        disposition: capsule.disposition,
        completedAt: capsule.completedAt,
        facts,
      });
      expect(terminal.publication).toBe("unpublished");
      expect((yield* HistoryStoreApi.operations.loadHead("session-1"))?.activeExecutionId).toBe(
        "execution-1",
      );

      const recovered = yield* recoverTerminalPublication("session-1", project);
      expect(recovered?.result.status).toBe("published");
      expect((yield* TurnJournalAuthority.operations.read("execution-1"))?.format).toBe(
        "sweatpants.terminal-execution.v1",
      );
      expect(yield* HistoryStoreApi.operations.loadHead("session-1")).toMatchObject({
        activeExecutionId: null,
        latestCompletedExecutionId: "execution-1",
      });
      expect((yield* HistoryStoreApi.operations.readPage("session-1")).entries).toEqual([
        { turn: "turn-1", text: "TERMINAL_V1" },
      ]);
    });
    expect(invocations).toEqual({ provider: 1, tool: 1, child: 1 });
  });

  it("repairs capsule metadata when Session Head committed before markPublished", async () => {
    const history = createMemoryHistoryStore<Entry>();
    const memory = createMemoryExecutionStore();
    let failMark = true;
    const execution: ExecutionStore = {
      ...memory,
      *commitExecution(request) {
        if (
          failMark &&
          request.next.format === "sweatpants.terminal-execution.v1" &&
          request.next.publication === "published"
        ) {
          failMark = false;
          throw new Error("semantic fault after Session Head CAS");
        }
        return yield* memory.commitExecution(request);
      },
    };
    await run(function* () {
      yield* installExecutionStore(execution);
      yield* installHistoryStore(history);
      yield* beginTurnPublication({
        executionId: "execution-1",
        sessionId: "session-1",
        turnId: "turn-1",
        rootTaskId: "root",
        rootProgram: capsule.rootProgram,
      });
      let faulted = false;
      try {
        yield* completeAndPublishTurn({
          executionId: "execution-1",
          outcome: capsule.outcome,
          disposition: "completed",
          completedAt: 100,
          facts,
          project,
        });
      } catch {
        faulted = true;
      }
      expect(faulted).toBe(true);
      expect(yield* HistoryStoreApi.operations.loadHead("session-1")).toMatchObject({
        activeExecutionId: null,
        latestCompletedExecutionId: "execution-1",
      });

      const recovered = yield* recoverTerminalPublication("session-1", project);
      expect(recovered?.result.status).toBe("already_published");
      const terminal = yield* TurnJournalAuthority.operations.read("execution-1");
      if (terminal?.format !== "sweatpants.terminal-execution.v1") {
        throw new Error("Expected terminal authority state");
      }
      expect(terminal.publication).toBe("published");
      expect((yield* HistoryStoreApi.operations.readPage("session-1")).entries).toHaveLength(1);
    });
  });

  it("normal completion does not return until the capsule is published", async () => {
    const history = createMemoryHistoryStore<Entry>();
    await run(function* () {
      yield* installExecutionStore(createMemoryExecutionStore());
      yield* installHistoryStore(history);
      yield* beginTurnPublication({
        executionId: "execution-1",
        sessionId: "session-1",
        turnId: "turn-1",
        rootTaskId: "root",
        rootProgram: capsule.rootProgram,
      });
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
      if (terminal?.format !== "sweatpants.terminal-execution.v1") {
        throw new Error("Expected terminal authority state");
      }
      expect(terminal.publication).toBe("published");
    });
  });

  it("rejects facts outside the capsule's accepted identity and sequence frontier", async () => {
    const history = createMemoryHistoryStore<Entry>();
    let failure: unknown;
    await run(function* () {
      yield* installHistoryStore(history);
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
