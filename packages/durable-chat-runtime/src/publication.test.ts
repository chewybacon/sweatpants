import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryHistoryStore } from "@sweatpants/history-store/memory";
import { HistoryStoreApi, installHistoryStore } from "@sweatpants/history-store/port";
import type { TerminalCapsule } from "@sweatpants/durable-execution";
import { publishTurn, type ProjectionFactEnvelope } from "./index.ts";

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
        facts,
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
        facts,
        project,
        *markPublished(pointer) {
          marked.push(pointer.segmentId);
        },
      });
      expect(recovered.status).toBe("published");

      const repeated = yield* publishTurn({
        capsule,
        facts,
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
});
