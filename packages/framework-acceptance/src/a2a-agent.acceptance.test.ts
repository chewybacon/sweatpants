import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import { connectStandardAgent } from "./lib/a2a-scenario.ts";
import {
  ACCEPTANCE_AGENT_MODEL_ID,
  createAcceptanceStandardAgent,
} from "./fixtures/acceptance-standard-agent.ts";

type Binding = TestRigOptions["binding"];

async function invokeStandardAgent(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_AGENT_MODEL_ID,
      createApplication: createAcceptanceStandardAgent,
    },
    function* (s) {
      const agent = yield* connectStandardAgent(s);
      expect(agent.card).toMatchObject({ name: "acceptance-standard-agent", version: "1" });

      const turn = yield* agent.send({
        messageId: "a2a-acceptance-message-1",
        role: "user",
        parts: [{ text: "A2A_ACCEPTANCE_QUESTION_V1" }],
      });
      const sample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain("A2A_ACCEPTANCE_QUESTION_V1");
      });
      yield* sample.respond.text("A2A_ACCEPTANCE_ANSWER_V1");

      const result = yield* turn.complete();
      expect(result.type).toBe("task");
      if (result.type !== "task") {
        throw new Error("expected an A2A task result");
      }
      expect(result.task.status.state).toBe("completed");
      expect(JSON.stringify(result.task.history)).toContain("A2A_ACCEPTANCE_ANSWER_V1");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "standard A2A agent through the %s test-rig binding",
  (binding) => {
    it("discovers the agent, controls its model sample, and completes the task", async () => {
      await invokeStandardAgent(binding);
    });
  },
);
