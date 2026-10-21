import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  createDurabilityAcceptanceApplication,
} from "../lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runPendingElicitReconnect(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createDurabilityAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation({ initialToolChoice: "required" });
      const turn = yield* conversation.send("PENDING_ELICIT_RECONNECT_V1");

      const initial = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* initial.respond.toolCalls([
        {
          id: "pending-reconnect-durable-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "pending-reconnect" },
        },
      ]);

      const sample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* sample.respond.text("PENDING_ELICIT_RECONNECT_SAMPLE_V1");

      const pending = yield* turn.elicit("chooseOption");
      const requestsBeforeReconnect = s.model.requests().length;
      expect(requestsBeforeReconnect).toBe(2);

      const reconnected = yield* conversation.reopen();
      expect(s.model.requests()).toHaveLength(requestsBeforeReconnect);
      expect(JSON.stringify(reconnected.snapshot())).toContain(pending.elicitId);
      expect(JSON.stringify(reconnected.snapshot())).toContain('"state":"pending"');

      const resumed = reconnected.resumePendingElicit("chooseOption");
      const recovered = yield* resumed.elicit("chooseOption");
      expect(recovered.elicitId).toBe(pending.elicitId);

      yield* recovered.accept({ selected: "pending-reconnect-alpha" });

      const terminal = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* terminal.respond.text("PENDING_ELICIT_RECONNECT_COMPLETE_V1");

      const settled = yield* resumed.settled();
      expect(settled.text).toContain("PENDING_ELICIT_RECONNECT_COMPLETE_V1");
      expect(settled.events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(
        1,
      );
      expect(s.model.requests()).toHaveLength(3);

      const complete = reconnected.snapshot();
      expect(JSON.stringify(complete)).toContain(pending.elicitId);
      expect(JSON.stringify(complete)).toContain('"state":"responded"');
    },
  );
}

describe("single durable elicitation pending reconnect", () => {
  it("recovers and settles exactly once in-process", async () => {
    await runPendingElicitReconnect("in-process");
  }, 30_000);

  it("recovers and settles exactly once over HTTP", async () => {
    await runPendingElicitReconnect("http");
  }, 30_000);
});

async function runStreamedReplyBeforeParkReconnect(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createDurabilityAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation();
      const first = yield* conversation.send("Let's play a pirate-themed game.");
      const greeting = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* greeting.respond.text("Aye, let's play!");
      yield* first.settled();

      const followUp = "Can we change the choices to pirate-themed words?";
      const narration =
        "Aye, here be the new words: Cannon, Sail, and Cutlass. I'll start a fresh game with them.";
      const turn = yield* conversation.send(followUp);
      const reply = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* reply.respond.textAndToolCalls(narration, [
        {
          id: "pirate-follow-up-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "pirate-choices" },
        },
      ]);
      // Prove the reply reached the live stream before the tool parks.
      yield* turn.textDelta(narration);
      const sample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* sample.respond.text("Cannon, Sail, or Cutlass?");
      const pending = yield* turn.elicit("chooseOption");

      const reconnected = yield* conversation.reopen();
      const restored = JSON.stringify(reconnected.snapshot());
      const requestsAfterReload = s.model.requests().length;
      const resumed = reconnected.resumePendingElicit("chooseOption");
      const recovered = yield* resumed.elicit("chooseOption");
      yield* recovered.accept({ selected: "pirate-choices-alpha" });
      const terminal = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* terminal.respond.text("Round complete.");
      yield* resumed.settled();

      // Finish the parked turn before asserting against the captured reload state.
      expect(recovered.elicitId).toBe(pending.elicitId);
      expect(requestsAfterReload).toBe(3);
      expect(restored).toContain("Aye, let's play!");
      expect(restored).toContain(followUp);
      expect(restored).toContain(pending.elicitId);
      expect(restored).toContain(narration);
    },
  );
}

describe("streamed assistant reply before a durable workflow parks", () => {
  it.each(["in-process", "http"] as const)(
    "retains the follow-up reply after reload over %s",
    async (binding) => {
      await runStreamedReplyBeforeParkReconnect(binding);
    },
    30_000,
  );
});
