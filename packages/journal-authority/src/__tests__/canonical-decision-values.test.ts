import { run } from "effection";
import { describe, expect, it } from "vitest";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { createCapabilityKeyring, createInMemoryJournal } from "../index.ts";

const options = {
  journalId: "canonical-decisions",
  keyring: createCapabilityKeyring("canonical-decisions", [
    { keyId: "test", secret: "canonical-decisions-secret-32-bytes" },
  ]),
};
const opening = {
  type: "execution.open-task" as const,
  request: {
    sessionId: "session",
    taskId: "root",
    turnId: "turn",
    manifest: {
      programId: "canonical-decisions",
      version: "1",
      digest: "a".repeat(64),
      inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      elicits: {},
      effects: {},
      capabilities: {
        durableEmissions: true,
        structuredChildren: false,
        replay: "strict" as const,
      },
    },
    input: null,
    executionEpoch: 1,
    attachmentId: "attachment",
    audience: "workflow-host",
  },
};

describe("admitted decision values", () => {
  it("recognizes reordered completion values after restoration and rejects changed content", async () => {
    await run(function* () {
      const journal = yield* createInMemoryJournal(options);
      const { programCapability } = yield* journal.advance(opening);
      const complete = {
        sessionId: "session",
        taskId: "root",
        actionIndex: 0,
        programCapability,
        outcome: { status: "ok" as const, value: { z: "😀", a: 1 } },
      };
      expect(
        yield* journal.advance({ type: "execution.complete-task", request: complete }),
      ).toMatchObject({ status: "accepted" });
      const snapshot = yield* journal.exportSnapshot();
      const restored = yield* createInMemoryJournal({ ...options, snapshot });
      expect(
        yield* restored.advance({
          type: "execution.complete-task",
          request: {
            ...complete,
            outcome: { status: "ok", value: { a: 1, z: "😀" } },
          },
        }),
      ).toMatchObject({ status: "duplicate" });
      let failure: unknown;
      try {
        yield* restored.advance({
          type: "execution.complete-task",
          request: {
            ...complete,
            outcome: { status: "ok", value: { a: 2, z: "😀" } },
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "nondeterminism_detected" });
      expect(yield* restored.exportSnapshot()).toEqual(snapshot);
    });
  });

  it("uses canonical UTF-8 payload bytes for both inline admission and cumulative emission quotas", async () => {
    await run(function* () {
      const journal = yield* createInMemoryJournal({
        ...options,
        maxOutcomeBytes: 6,
        emissionPolicy: { maxCumulativeEmissionBytes: 10 },
      });
      const { programCapability } = yield* journal.advance(opening);
      const request = { sessionId: "session", taskId: "root", programCapability };
      yield* journal.advance({
        type: "execution.append-emission",
        request: {
          ...request,
          actionIndex: 0,
          descriptor: { eventType: "text", payload: "😀" },
        },
      });
      yield* journal.advance({
        type: "execution.append-emission",
        request: {
          ...request,
          actionIndex: 1,
          descriptor: { eventType: "text", payload: "é" },
        },
      });
      let failure: unknown;
      try {
        yield* journal.advance({
          type: "execution.append-emission",
          request: {
            ...request,
            actionIndex: 2,
            descriptor: { eventType: "text", payload: null },
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "emission_quota_exceeded" });
      const snapshot = yield* journal.exportSnapshot();
      expect(snapshot.sessions[0]?.[1].execution.tasks[0]?.cumulativeEmissionBytes).toBe(10);
      expect(
        (yield* journal.readSession("session")).filter(
          (record) => record.payload.type === "DurableEmission",
        ),
      ).toHaveLength(2);
    });
  });
});
