import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runPendingElicitReconnect(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
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
      expect(settled.events.filter((event) => event.type === "RUN_FINISHED")).toHaveLength(1);
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
