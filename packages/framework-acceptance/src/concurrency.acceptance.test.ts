import { describe, expect, it } from "vitest";
import { withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runConcurrentIsolation(binding: Binding, failA: boolean): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
    },
    async (rig) => {
      const conversationA = rig.chat.conversation({ conversationId: "isolation-a" });
      const conversationB = rig.chat.conversation({ conversationId: "isolation-b" });

      const requestAPromise = rig.model.expectRequest((request) => {
        expect(JSON.stringify(request.body.input)).toContain("CONVERSATION_A_V1");
      });
      const turnA = conversationA.send("CONVERSATION_A_V1");
      const deltaAPromise = turnA.expectTextDelta("A1");
      const requestA = await requestAPromise;
      const streamA = await requestA.respond.text({
        chunks: ["A1", "-A2"],
        release: "manual",
      });
      await streamA.releaseNext();
      await deltaAPromise;

      // A remains active while B starts and receives its own provider stream.
      const requestBPromise = rig.model.expectRequest((request) => {
        expect(JSON.stringify(request.body.input)).toContain("CONVERSATION_B_V1");
      });
      const turnB = conversationB.send("CONVERSATION_B_V1");
      const deltaBPromise = turnB.expectTextDelta("B1");
      const requestB = await requestBPromise;
      const streamB = await requestB.respond.text({
        chunks: ["B1", "-B2"],
        release: "manual",
      });
      await streamB.releaseNext();
      await deltaBPromise;

      if (failA) {
        await streamA.fail({ code: "conversation_a_failed", message: "planned A failure" });
        await expect(turnA.complete()).rejects.toThrow();
      } else {
        await streamA.finish();
        expect((await turnA.complete()).text).toBe("A1-A2");
      }

      // B remains independently live after A completes or fails.
      await streamB.finish();
      expect((await turnB.complete()).text).toBe("B1-B2");

      expect(conversationA.transcript().text).not.toContain("B1");
      expect(conversationB.transcript().text).not.toContain("A1");
      expect(conversationA.transcript().conversationId).toBe("isolation-a");
      expect(conversationB.transcript().conversationId).toBe("isolation-b");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "concurrent conversation isolation through the %s binding",
  (binding) => {
    it("keeps interleaved streams isolated", async () => {
      await runConcurrentIsolation(binding, false);
    });

    it("keeps B healthy when A fails", async () => {
      await runConcurrentIsolation(binding, true);
    });
  },
);
