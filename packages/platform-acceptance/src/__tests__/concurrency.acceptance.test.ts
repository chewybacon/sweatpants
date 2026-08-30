import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "../lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runConcurrentIsolation(binding: Binding, failA: boolean): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
    },
    function* (s) {
      const conversationA = s.conversation({ conversationId: "isolation-a" });
      const conversationB = s.conversation({ conversationId: "isolation-b" });

      const turnA = yield* conversationA.send("CONVERSATION_A_V1");
      const requestA = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain("CONVERSATION_A_V1");
      });
      const streamA = yield* requestA.respond.textStream(["A1", "-A2"]);
      yield* streamA.releaseNext();
      yield* turnA.textDelta("A1");

      // A remains active while B starts and receives its own provider stream.
      const turnB = yield* conversationB.send("CONVERSATION_B_V1");
      const requestB = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain("CONVERSATION_B_V1");
      });
      const streamB = yield* requestB.respond.textStream(["B1", "-B2"]);
      yield* streamB.releaseNext();
      yield* turnB.textDelta("B1");

      if (failA) {
        yield* streamA.fail({ code: "conversation_a_failed", message: "planned A failure" });
        yield* turnA.failure();
      } else {
        yield* streamA.finish();
        expect((yield* turnA.settled()).text).toBe("A1-A2");
      }

      // B remains independently live after A completes or fails.
      yield* streamB.finish();
      expect((yield* turnB.settled()).text).toBe("B1-B2");

      expect(conversationA.transcript().text).not.toContain("B1");
      expect(conversationB.transcript().text).not.toContain("A1");
      expect(conversationA.transcript().conversationId).toBe("isolation-a");
      expect(conversationB.transcript().conversationId).toBe("isolation-b");
      expect(conversationA.transcript().conversationId).toBe("isolation-a");
      expect(conversationB.transcript().conversationId).toBe("isolation-b");
    },
  );
}

describe("HTTP concurrent conversation isolation", () => {
  // binding-conformance: isolation is strongest across independent HTTP streams.
  it("keeps interleaved streams isolated", async () => {
    await runConcurrentIsolation("http", false);
  });

  it("keeps B healthy when A fails", async () => {
    await runConcurrentIsolation("http", true);
  });
});
