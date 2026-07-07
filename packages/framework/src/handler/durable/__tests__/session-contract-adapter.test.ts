import { resource, run } from "effection";
import { describe, expect, it } from "vitest";

import { createSessionContractInMemoryStore, waitToken } from "@sweatpants/session-contract";

import { createDurableChatEngineSessionAdapter } from "../session-contract-adapter.ts";
import type { StreamEvent } from "../../../lib/chat/session/streaming.ts";

function streamOf(events: StreamEvent[]) {
  return resource(function* (provide) {
    let index = 0;
    yield* provide({
      *next() {
        const value = events[index++];
        return value === undefined ? { done: true, value: undefined } : { done: false, value };
      },
    });
  });
}

describe("durable chat engine session-contract adapter", () => {
  it("projects chat-engine emissions, interrupts, resumes, and turn boundaries into the session contract", async () => {
    await run(function* () {
      const bufferStore = createSessionContractInMemoryStore();
      const session = yield* createDurableChatEngineSessionAdapter({
        sessionId: "cea-contract",
        bufferStore,
        *createEngine() {
          return streamOf([
            { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
            { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello" },
            {
              type: "RUN_FINISHED",
              threadId: "t1",
              runId: "r1",
              outcome: {
                type: "interrupt",
                interrupts: [
                  {
                    id: "approve",
                    reason: "input_required",
                    message: "Approve?",
                    responseSchema: { type: "object" },
                    expiresAt: "2099-01-01T00:00:00.000Z",
                    metadata: { source: "chat-engine", sessionId: "leaked-topology" },
                  },
                ],
              },
            },
          ]);
        },
      });

      yield* session.send({ role: "user", content: "hello" }, { idempotencyKey: "cea-message" });
      let status = yield* session.status();
      expect(status.state).toBe("parked");
      const elicitWait = status.pendingWaits.at(-1)!;
      expect(elicitWait).toMatchObject({ kind: "elicit", expiresAt: "2099-01-01T00:00:00.000Z" });
      // Topology fields in metadata must be sanitized so the log validates.
      const replayEvents = yield* session.events();
      let elicitContext: Record<string, unknown> | undefined;
      for (let i = 0; i < 10; i += 1) {
        const next = yield* replayEvents.next();
        if (next.done) break;
        if (next.value.kind === "wait" && next.value.wait === "elicit") {
          elicitContext = (next.value as { payload: { context?: Record<string, unknown> } }).payload.context;
          break;
        }
      }
      expect(elicitContext).not.toHaveProperty("sessionId");

      yield* session.respond(waitToken("cea-contract", elicitWait.waitSeq), { approved: true }, {
        idempotencyKey: "cea-resume",
        wait: "elicit",
      });
      status = yield* session.status();
      expect(status.pendingWaits.at(-1)?.kind).toBe("message");

      const replay = yield* session.events();
      const kinds: string[] = [];
      for (let i = 0; i < 9; i += 1) {
        const next = yield* replay.next();
        if (next.done) break;
        kinds.push(next.value.kind);
      }
      expect(kinds).toContain("emission");
      expect(kinds).toContain("wait");
      expect(kinds).toContain("answer");
      expect(kinds).toContain("checkpoint");
    });
  });

  it("projects every AG-UI interrupt as a separate elicit wait", async () => {
    await run(function* () {
      const bufferStore = createSessionContractInMemoryStore();
      const session = yield* createDurableChatEngineSessionAdapter({
        sessionId: "cea-multi-interrupt",
        bufferStore,
        *createEngine() {
          return streamOf([
            {
              type: "RUN_FINISHED",
              threadId: "t1",
              runId: "r1",
              outcome: {
                type: "interrupt",
                interrupts: [
                  { id: "confirm", reason: "input_required", message: "Confirm?", responseSchema: {} },
                  { id: "details", reason: "input_required", message: "Details?", responseSchema: {} },
                ],
              },
            },
          ]);
        },
      });

      yield* session.send({ role: "user", content: "hello" }, { idempotencyKey: "cea-multi-msg" });
      const status = yield* session.status();
      const elicitWaits = status.pendingWaits.filter((w) => w.kind === "elicit");
      expect(elicitWaits).toHaveLength(2);
      expect(elicitWaits[0]!.token).not.toBe(elicitWaits[1]!.token);
    });
  });
});
