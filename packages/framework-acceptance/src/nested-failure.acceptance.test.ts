import { describe, expect, it } from "vitest";
import { withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  NESTED_SAMPLE_PROMPT_MARKER,
  acceptanceBookingTool,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];
type NestedFailure = "throw_after_resume" | "sample_failure";

async function runNestedFailure(binding: Binding, failure: NestedFailure): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const callId = `nested-failure-${failure}`;
      const outerPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({ tools: [acceptanceBookingTool] });
      const turn = conversation.send(`NESTED_FAILURE_${failure.toUpperCase()}_V1`);
      const flightPromise = turn.expectElicit("pickFlight");
      const seatPromise = turn.expectElicit("pickSeat");
      await (
        await outerPromise
      ).respond.toolCalls([
        {
          id: callId,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: {
            from: "NYC",
            destination: "LAX",
            behavior: failure === "throw_after_resume" ? "throw_after_resume" : "complete",
          },
        },
      ]);
      const nestedPromise =
        failure === "sample_failure"
          ? rig.model.expectRequest((request) => {
              expect(JSON.stringify(request.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
            })
          : undefined;
      await (await flightPromise).accept({ flightId: "FL001" });
      await (await seatPromise).accept({ row: 2, seat: "A" });

      if (nestedPromise) {
        const nested = await nestedPromise;
        await nested.respond.error({
          code: "nested_provider_failed",
          message: "planned nested provider failure",
          status: 503,
        });
      }

      await expect(turn.complete()).rejects.toThrow();
      const recoveryPromise = rig.model.expectRequest((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain(`RECOVER_NESTED_${failure.toUpperCase()}_V1`);
        expect(input).toContain(callId);
        expect(input).toMatch(/error|fail/i);
        expect(input).not.toContain(NESTED_SAMPLE_PROMPT_MARKER);
        expect(input).not.toContain("worker-tool-adapter.ts");
      });
      const recovery = conversation.send(`RECOVER_NESTED_${failure.toUpperCase()}_V1`);
      await (await recoveryPromise).respond.text(`RECOVERED_NESTED_${failure.toUpperCase()}_V1`);
      expect((await recovery.complete()).text).toBe(`RECOVERED_NESTED_${failure.toUpperCase()}_V1`);
    },
  );
}

async function runFinalSampleFailure(binding: Binding): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const callId = "final-sample-failure-call";
      const outerPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({ tools: [acceptanceBookingTool] });
      const turn = conversation.send("FINAL_SAMPLE_FAILURE_V1");
      const flightPromise = turn.expectElicit("pickFlight");
      const seatPromise = turn.expectElicit("pickSeat");
      const nestedPromise = rig.model.expectRequest((request) => {
        expect(JSON.stringify(request.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      await (
        await outerPromise
      ).respond.toolCalls([
        {
          id: callId,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX", behavior: "complete" },
        },
      ]);
      await (await flightPromise).accept({ flightId: "FL001" });
      await (await seatPromise).accept({ row: 2, seat: "A" });
      const finalPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await (await nestedPromise).respond.text("nested sample succeeded");
      await (
        await finalPromise
      ).respond.error({
        code: "final_provider_failed",
        message: "planned final provider failure",
        status: 503,
      });
      await expect(turn.complete()).rejects.toThrow();

      const recoveryPromise = rig.model.expectRequest((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain("RECOVER_FINAL_SAMPLE_FAILURE_V1");
        expect(input).toContain(callId);
        expect(input).toContain("TOOL_RESULT_V1");
        expect(input).not.toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      const recovery = conversation.send("RECOVER_FINAL_SAMPLE_FAILURE_V1");
      await (await recoveryPromise).respond.text("RECOVERED_FINAL_SAMPLE_FAILURE_V1");
      expect((await recovery.complete()).text).toBe("RECOVERED_FINAL_SAMPLE_FAILURE_V1");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "nested tool failure through the %s binding",
  (binding) => {
    it.each(["throw_after_resume", "sample_failure"] as const)(
      "records and recovers from %s",
      async (failure) => {
        await runNestedFailure(binding, failure);
      },
      30_000,
    );

    it("preserves the tool result when the final outer sample fails", async () => {
      await runFinalSampleFailure(binding);
    }, 30_000);
  },
);
