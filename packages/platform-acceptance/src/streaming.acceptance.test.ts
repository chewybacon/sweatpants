import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  createAcceptanceApplication,
  type AcceptanceApplicationInspection,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runStreamingScenario(binding: Binding): Promise<void> {
  let inspection: AcceptanceApplicationInspection | undefined;
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication(context) {
        return createAcceptanceApplication(context, (created) => {
          inspection = created;
        });
      },
    },
    function* (s) {
      const order: string[] = [];
      const conversation = s.conversation();
      const turn = yield* conversation.send("Stream a deterministic greeting");
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID, stream: true });
      expect(request.pullId).not.toBe("");
      const stream = yield* request.respond.textStream(["hello", " world"]);

      order.push("release");
      yield* stream.releaseNext();
      expect(yield* turn.textDelta("hello")).toMatchObject({ delta: "hello" });
      order.push("delta");

      order.push("finish");
      yield* stream.finish();
      const transcript = yield* turn.settled();
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
      const opened = yield* inspection.journalStore.open(conversation.conversationId);
      const journal = yield* opened.readJournal(conversation.conversationId);
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
