import { describe, expect, it } from "vitest";
import { withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];
type FailureKind = "error" | "partial" | "disconnect";

async function recoverConversation(binding: Binding, kind: FailureKind): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    async (rig) => {
      const conversation = rig.chat.conversation();
      const failedRequestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const failedTurn = conversation.send(`FAILURE_${kind.toUpperCase()}_V1`);
      const failedRequest = await failedRequestPromise;

      if (kind === "error") {
        await failedRequest.respond.error({
          code: "provider_unavailable",
          message: "planned provider failure",
          status: 503,
        });
      } else {
        const partialPromise = failedTurn.expectTextDelta("PARTIAL_V1");
        const stream = await failedRequest.respond.text({
          chunks: ["PARTIAL_V1"],
          release: "manual",
        });
        await stream.releaseNext();
        await expect(partialPromise).resolves.toMatchObject({ delta: "PARTIAL_V1" });
        if (kind === "partial") {
          await stream.fail({ code: "stream_failed", message: "planned stream failure" });
        } else {
          await stream.disconnect();
        }
      }

      await expect(failedTurn.complete()).rejects.toThrow();
      const events = conversation.transcript().events;
      expect(events.filter((event) => event.type === "RUN_ERROR")).toHaveLength(1);
      expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(false);
      if (kind !== "error") {
        expect(conversation.transcript().text).toContain("PARTIAL_V1");
      }

      const recoveryRequestPromise = rig.model.expectRequest((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain(`RECOVERY_AFTER_${kind.toUpperCase()}_V1`);
        if (kind !== "error") {
          expect(input).toContain("PARTIAL_V1");
        }
      });
      const recoveryTurn = conversation.send(`RECOVERY_AFTER_${kind.toUpperCase()}_V1`);
      await (await recoveryRequestPromise).respond.text(`RECOVERED_${kind.toUpperCase()}_V1`);
      const recovered = await recoveryTurn.complete();
      expect(recovered.outcome).toBe("success");
      expect(recovered.text).toBe(`RECOVERED_${kind.toUpperCase()}_V1`);
    },
  );
}

async function completeEmptyAssistant(binding: Binding): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const requestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation();
      const turn = conversation.send("EMPTY_ASSISTANT_V1");
      await (await requestPromise).respond.text("");
      const transcript = await turn.complete();
      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toBe("");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "provider failure recovery through the %s binding",
  (binding) => {
    it.each(["error", "partial", "disconnect"] as const)(
      "recovers the conversation after %s failure",
      async (kind) => {
        await recoverConversation(binding, kind);
      },
      30_000,
    );

    it("completes an empty assistant response without hanging", async () => {
      await completeEmptyAssistant(binding);
    });
  },
);
