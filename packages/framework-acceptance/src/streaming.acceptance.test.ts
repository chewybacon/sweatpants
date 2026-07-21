import { run } from "effection";
import { describe, expect, it } from "vitest";
import { withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  createAcceptanceApplication,
  type AcceptanceApplicationInspection,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runStreamingScenario(binding: Binding): Promise<void> {
  let inspection: AcceptanceApplicationInspection | undefined;
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication(context) {
        return createAcceptanceApplication(context, (created) => {
          inspection = created;
        });
      },
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
      expect(
        transcript.events
          .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
          .map((event) => event.delta),
      ).toEqual(["hello", " world"]);
      expect(order).toEqual(["release", "delta", "finish", "complete"]);

      if (!inspection) {
        throw new Error("acceptance application inspection was not installed");
      }
      const journalStore = inspection.journalStore;
      const journal = await run(function* () {
        const opened = yield* journalStore.open(conversation.conversationId);
        return yield* opened.readJournal(conversation.conversationId);
      });
      expect(JSON.stringify(journal)).not.toContain('"eventType":"model_token"');
      expect(
        journal.filter(
          (record) =>
            record.payload.type === "DurableEmission" &&
            record.payload.descriptor.eventType === "assistant_text",
        ),
      ).toHaveLength(1);
    },
  );
}

describe.each<Binding>(["in-process", "http"])("streaming through the %s binding", (binding) => {
  it("observes a released provider delta before turn completion", async () => {
    await runStreamingScenario(binding);
  });
});
