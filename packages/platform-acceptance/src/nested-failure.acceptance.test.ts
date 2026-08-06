import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  NESTED_SAMPLE_PROMPT_MARKER,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];
type NestedFailure = "throw_after_resume" | "sample_failure";

async function runNestedFailure(binding: Binding, failure: NestedFailure): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const callId = `nested-failure-${failure}`;
      const turn = yield* conversation.send({ text: `NESTED_FAILURE_${failure.toUpperCase()}_V1` });
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
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
      const flight = yield* turn.elicit("pickFlight");
      yield* flight.accept({ flightId: "FL001" });
      const seat = yield* turn.elicit("pickSeat");
      yield* seat.accept({ row: 2, seat: "A" });

      if (failure === "sample_failure") {
        const nested = yield* s.model.request((request) => {
          expect(JSON.stringify(request.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
        });
        yield* nested.respond.error({
          code: "nested_provider_failed",
          message: "planned nested provider failure",
          status: 503,
        });
      }

      yield* turn.failure();
      const recovery = yield* conversation.send({
        text: `RECOVER_NESTED_${failure.toUpperCase()}_V1`,
      });
      const recoveryRequest = yield* s.model.request((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain(`RECOVER_NESTED_${failure.toUpperCase()}_V1`);
        expect(input).toContain(callId);
        expect(input).toMatch(/error|fail/i);
        expect(input).not.toContain(NESTED_SAMPLE_PROMPT_MARKER);
        expect(input).not.toContain("worker-tool-adapter.ts");
      });
      yield* recoveryRequest.respond.text(`RECOVERED_NESTED_${failure.toUpperCase()}_V1`);
      expect((yield* recovery.settled()).text).toBe(`RECOVERED_NESTED_${failure.toUpperCase()}_V1`);
    },
  );
}

async function runFinalSampleFailure(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const callId = "final-sample-failure-call";
      const turn = yield* conversation.send({ text: "FINAL_SAMPLE_FAILURE_V1" });
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: callId,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX", behavior: "complete" },
        },
      ]);
      const flight = yield* turn.elicit("pickFlight");
      yield* flight.accept({ flightId: "FL001" });
      const seat = yield* turn.elicit("pickSeat");
      yield* seat.accept({ row: 2, seat: "A" });
      const nested = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      yield* nested.respond.text("nested sample succeeded");
      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* finalRequest.respond.error({
        code: "final_provider_failed",
        message: "planned final provider failure",
        status: 503,
      });
      yield* turn.failure();

      const recovery = yield* conversation.send({ text: "RECOVER_FINAL_SAMPLE_FAILURE_V1" });
      const recoveryRequest = yield* s.model.request((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain("RECOVER_FINAL_SAMPLE_FAILURE_V1");
        expect(input).toContain(callId);
        expect(input).toContain("TOOL_RESULT_V1");
        expect(input).not.toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      yield* recoveryRequest.respond.text("RECOVERED_FINAL_SAMPLE_FAILURE_V1");
      expect((yield* recovery.settled()).text).toBe("RECOVERED_FINAL_SAMPLE_FAILURE_V1");
    },
  );
}

describe("nested tool failure semantics", () => {
  const binding: Binding = "in-process";

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
});
