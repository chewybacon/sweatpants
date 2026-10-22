import { describe, expect, it } from "vitest";
import { call, spawn } from "effection";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { useClient, waitForSnapshot } from "../../support/client.ts";

const options = { binding: "http" as const, createApplication };

describe("concurrent public conversations", () => {
  for (const failA of [false, true]) {
    it(`isolates interleaved streams when A ${failA ? "fails" : "completes"}`, async () => {
      await withTestScenario(options, function* (rig) {
        // Arrange: separate public clients share one real HTTP application.
        const a = yield* useClient(rig, { threadId: "isolation-a" });
        const b = yield* useClient(rig, { threadId: "isolation-b" });

        // Act: start A and hold its stream open while B begins.
        const sendingA = yield* spawn(() => call(() => a.sendMessage("Conversation A")));
        const requestA = yield* rig.model.request();
        expect(JSON.stringify(requestA.body.input)).toContain("Conversation A");
        const streamA = yield* requestA.respond.textStream(["A1", "-A2"]);
        yield* streamA.releaseNext();
        yield* waitForSnapshot(a, (state) => JSON.stringify(state.messages).includes("A1"));
        const sendingB = yield* spawn(() => call(() => b.sendMessage("Conversation B")));
        const requestB = yield* rig.model.request();
        expect(JSON.stringify(requestB.body.input)).toContain("Conversation B");
        expect(JSON.stringify(requestB.body.input)).not.toContain("Conversation A");
        const streamB = yield* requestB.respond.textStream(["B1", "-B2"]);
        yield* streamB.releaseNext();
        yield* waitForSnapshot(b, (state) => JSON.stringify(state.messages).includes("B1"));

        // Act: settle A independently, then finish B.
        if (failA) {
          yield* streamA.fail({ code: "a_failed", message: "Planned A failure" });
        } else {
          yield* streamA.finish();
        }
        const settledA = yield* waitForSnapshot(
          a,
          (state) => state.status === (failA ? "error" : "ready"),
        );
        yield* sendingA;
        yield* streamB.finish();
        const settledB = yield* waitForSnapshot(b, (state) => state.status === "ready");
        yield* sendingB;

        // Assert: no text, authority identity, or failure crosses conversations.
        expect(JSON.stringify(settledA.messages)).not.toContain("B1");
        expect(JSON.stringify(settledB.messages)).not.toContain("A1");
        expect(JSON.stringify(settledB.messages)).toContain("B1-B2");
        if (!failA) {
          expect(JSON.stringify(settledA.messages)).toContain("A1-A2");
        }
        expect(settledB.error).toBeNull();
        expect(settledA.authority?.conversationId).toBe("isolation-a");
        expect(settledB.authority?.conversationId).toBe("isolation-b");
      });
    });
  }
});
