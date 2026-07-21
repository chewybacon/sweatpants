import { describe, expect, it } from "vitest";
import { withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import { ACCEPTANCE_MODEL_ID, createAcceptanceApplication } from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runStreamingScenario(binding: Binding): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
    },
    async (rig) => {
      const order: string[] = [];
      const requestPromise = rig.model.expectRequest({
        model: ACCEPTANCE_MODEL_ID,
        stream: true,
      });

      const conversation = rig.chat.conversation();
      const turn = conversation.send("Stream a deterministic greeting");
      const deltaPromise = turn.expectTextDelta("hello");

      const request = await requestPromise;
      expect(request.pullId).not.toBe("");

      const stream = await request.respond.text({
        chunks: ["hello", " world"],
        release: "manual",
      });

      order.push("release");
      await stream.releaseNext();
      await expect(deltaPromise).resolves.toMatchObject({ delta: "hello" });
      order.push("delta");

      order.push("finish");
      await stream.finish();

      const transcript = await turn.complete();
      order.push("complete");

      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toBe("hello world");
      expect(order).toEqual(["release", "delta", "finish", "complete"]);
    },
  );
}

describe.each<Binding>(["in-process", "http"])("streaming through the %s binding", (binding) => {
  it("observes a released provider delta before turn completion", async () => {
    await runStreamingScenario(binding);
  });
});
