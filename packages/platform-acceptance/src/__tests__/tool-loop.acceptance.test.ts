import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_IMMEDIATE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_TOOL_RESULT_MARKER,
  IMMEDIATE_RESULT_MARKER,
  createAcceptanceApplication,
} from "../lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

async function runTwoCallScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation({
        initialToolChoice: "required",
      });
      const turn = yield* conversation.send("MULTI_TOOL_V1");
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* request.respond.toolCalls([
        {
          id: "multi-call-1",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "alpha", behavior: "complete" },
        },
        {
          id: "multi-call-2",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "beta", behavior: "complete" },
        },
      ]);
      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const outputs = records(finalRequest.body.input).filter(
        (item) => item["type"] === "function_call_output",
      );
      expect(outputs).toHaveLength(2);
      expect(outputs.map((item) => item["call_id"])).toEqual(["multi-call-1", "multi-call-2"]);
      expect(JSON.stringify(outputs)).toContain(IMMEDIATE_RESULT_MARKER);
      expect(JSON.stringify(outputs)).toContain("alpha");
      expect(JSON.stringify(outputs)).toContain("beta");
      yield* finalRequest.respond.text("MULTI_TOOL_TERMINAL_V1");
      expect((yield* turn.settled()).text).toBe("MULTI_TOOL_TERMINAL_V1");
    },
  );
}

async function runMixedRoutingScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation({});
      const turn = yield* conversation.send("MIXED_ROUTING_V1");
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* request.respond.toolCalls([
        {
          id: "mixed-ordinary-call",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "ordinary", behavior: "complete" },
        },
        {
          id: "mixed-durable-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "mixed" },
        },
      ]);
      const nested = yield* s.model.request((request_) => {
        expect(JSON.stringify(request_.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* nested.respond.text("mixed durable note");
      const elicit = yield* turn.elicit("chooseOption");
      yield* elicit.accept({ selected: "mixed-alpha" });

      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const outputs = records(finalRequest.body.input).filter(
        (item) => item["type"] === "function_call_output",
      );
      expect(outputs.map((item) => item["call_id"])).toEqual([
        "mixed-ordinary-call",
        "mixed-durable-call",
      ]);
      expect(JSON.stringify(outputs)).toContain(IMMEDIATE_RESULT_MARKER);
      expect(JSON.stringify(outputs)).toContain(DURABLE_TOOL_RESULT_MARKER);
      yield* finalRequest.respond.text("MIXED_ROUTING_TERMINAL_V1");
      expect((yield* turn.settled()).text).toBe("MIXED_ROUTING_TERMINAL_V1");
    },
  );
}

async function runTextThenToolScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send("TEXT_THEN_TOOL_V1");
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* request.respond.textAndToolCalls("TOOL_PREFACE_V1", [
        {
          id: "text-tool-call",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "after-text", behavior: "complete" },
        },
      ]);
      yield* turn.textDelta("TOOL_PREFACE_V1");
      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      expect(JSON.stringify(finalRequest.body.input)).toContain("TOOL_PREFACE_V1");
      expect(JSON.stringify(finalRequest.body.input)).toContain("text-tool-call");
      yield* finalRequest.respond.text("TEXT_THEN_TOOL_TERMINAL_V1");
      const transcript = yield* turn.settled();
      expect(transcript.text).toContain("TOOL_PREFACE_V1");
      expect(transcript.text).toContain("TEXT_THEN_TOOL_TERMINAL_V1");
    },
  );
}

async function runChunkedArgumentsScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send("CHUNKED_ARGUMENTS_V1");
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* request.respond.toolCalls(
        [
          {
            id: "chunked-call-1",
            name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
            arguments: { value: "chunked", behavior: "complete" },
          },
        ],
        { argumentChunkSize: 2 },
      );
      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      expect(JSON.stringify(finalRequest.body.input)).toContain("chunked");
      yield* finalRequest.respond.text("CHUNKED_ARGUMENTS_TERMINAL_V1");
      expect((yield* turn.settled()).text).toBe("CHUNKED_ARGUMENTS_TERMINAL_V1");
    },
  );
}

async function runMixedSuccessFailure(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send("MIXED_SUCCESS_FAILURE_V1");
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* request.respond.toolCalls([
        {
          id: "mixed-success-call",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "success-before-failure", behavior: "complete" },
        },
        {
          id: "mixed-failure-call",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "failure-after-success", behavior: "throw" },
        },
      ]);
      const afterFailure = yield* s.model.request((request_) => {
        const input = JSON.stringify(request_.body.input);
        expect(input).toContain("mixed-success-call");
        expect(input).toContain("mixed-failure-call");
        expect(input).toContain(IMMEDIATE_RESULT_MARKER);
        expect(input).toMatch(/error|fail/i);
      });
      yield* afterFailure.respond.text("MIXED_SUCCESS_FAILURE_TERMINAL_V1");
      expect((yield* turn.settled()).text).toBe("MIXED_SUCCESS_FAILURE_TERMINAL_V1");

      const recovery = yield* conversation.send("MIXED_SUCCESS_FAILURE_RECOVERY_V1");
      const recoveryRequest = yield* s.model.request((request_) => {
        const input = JSON.stringify(request_.body.input);
        expect(input).toContain("MIXED_SUCCESS_FAILURE_RECOVERY_V1");
        expect(input).toContain("mixed-success-call");
        expect(input).toContain("mixed-failure-call");
        expect(input).toContain(IMMEDIATE_RESULT_MARKER);
        expect(input).toMatch(/error|fail/i);
      });
      yield* recoveryRequest.respond.text("MIXED_SUCCESS_FAILURE_RECOVERED_V1");
      expect((yield* recovery.settled()).text).toBe("MIXED_SUCCESS_FAILURE_RECOVERED_V1");
    },
  );
}

async function runTerminalToolFailure(
  binding: Binding,
  failure: "throw" | "invalid_output" | "invalid_arguments" | "unknown" | "malformed",
): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send(`TOOL_FAILURE_${failure.toUpperCase()}_V1`);
      const request = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      if (failure === "malformed") {
        yield* request.respond.malformedToolCall({
          id: "failure-call",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: "{not-json",
        });
      } else {
        yield* request.respond.toolCalls([
          {
            id: "failure-call",
            name: failure === "unknown" ? "not_in_catalog" : ACCEPTANCE_IMMEDIATE_TOOL_NAME,
            arguments:
              failure === "invalid_arguments"
                ? {}
                : { value: failure, behavior: failure === "unknown" ? "complete" : failure },
          },
        ]);
      }
      const ordinaryForeignFailure = failure === "throw" || failure === "invalid_output";
      if (ordinaryForeignFailure) {
        const afterFailure = yield* s.model.request((request_) => {
          const input = JSON.stringify(request_.body.input);
          expect(input).toContain("failure-call");
          expect(input).toMatch(/error|fail|invalid/i);
        });
        yield* afterFailure.respond.text(`TOOL_FAILURE_${failure.toUpperCase()}_TERMINAL_V1`);
        expect((yield* turn.settled()).text).toBe(
          `TOOL_FAILURE_${failure.toUpperCase()}_TERMINAL_V1`,
        );
      } else {
        yield* turn.failure();
        expect(
          conversation.transcript().events.filter((event) => event.type === EventType.RUN_ERROR),
        ).toHaveLength(1);
      }

      const recovery = yield* conversation.send(`RECOVER_TOOL_FAILURE_${failure.toUpperCase()}_V1`);
      const recoveryRequest = yield* s.model.request((request_) => {
        const input = JSON.stringify(request_.body.input);
        expect(input).toContain(`RECOVER_TOOL_FAILURE_${failure.toUpperCase()}_V1`);
        expect(input).toContain("failure-call");
        expect(input).toMatch(/error|fail|invalid|unknown/i);
      });
      yield* recoveryRequest.respond.text(`RECOVERED_${failure.toUpperCase()}_V1`);
      expect((yield* recovery.settled()).text).toBe(`RECOVERED_${failure.toUpperCase()}_V1`);
    },
  );
}

async function runSequentialToolScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send("SEQUENTIAL_TOOL_LOOP_V1");
      const first = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* first.respond.toolCalls([
        {
          id: "sequential-call-1",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "first", behavior: "complete" },
        },
      ]);
      const second = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      expect(JSON.stringify(second.body.input)).toContain("sequential-call-1");
      yield* second.respond.toolCalls([
        {
          id: "sequential-call-2",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "second", behavior: "complete" },
        },
      ]);
      const third = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const serialized = JSON.stringify(third.body.input);
      expect(serialized).toContain("sequential-call-1");
      expect(serialized).toContain("sequential-call-2");
      yield* third.respond.text("SEQUENTIAL_TOOL_TERMINAL_V1");
      expect((yield* turn.settled()).text).toBe("SEQUENTIAL_TOOL_TERMINAL_V1");
      expect(s.model.requests()).toHaveLength(3);
    },
  );
}

async function runIterationLimitScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication(context) {
        return createAcceptanceApplication(context, undefined, { maxToolIterations: 2 });
      },
    },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send("MAX_ITERATIONS_V1");
      const first = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* first.respond.toolCalls([
        {
          id: "iteration-call-1",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "one", behavior: "complete" },
        },
      ]);
      const second = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* second.respond.toolCalls([
        {
          id: "iteration-call-2",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "two", behavior: "complete" },
        },
      ]);
      yield* turn.failure(/maximum|max_tool_iterations/i);
      expect(s.model.requests()).toHaveLength(2);
    },
  );
}

describe("tool loop semantics", () => {
  const binding: Binding = "in-process";

  it("correlates two tool calls from one response", async () => {
    await runTwoCallScenario(binding);
  });
  it("routes ordinary and durable calls from one response", async () => {
    await runMixedRoutingScenario(binding);
  }, 30_000);
  it("preserves assistant text emitted before a tool call", async () => {
    await runTextThenToolScenario(binding);
  });
  it("parses tool arguments split across provider chunks", async () => {
    await runChunkedArgumentsScenario(binding);
  });
  it("preserves a successful result when a later call fails", async () => {
    await runMixedSuccessFailure(binding);
  });
  it.each(["throw", "invalid_output", "invalid_arguments", "unknown", "malformed"] as const)(
    "fails once and recovers after %s tool behavior",
    async (failure) => {
      await runTerminalToolFailure(binding, failure);
    },
  );
  it("executes sequential tool calls across model iterations", async () => {
    await runSequentialToolScenario(binding);
  });
  it("enforces the maximum tool iteration limit", async () => {
    await runIterationLimitScenario(binding);
  });
});

describe("tool loop HTTP parity", () => {
  // binding-conformance: mixed routing crosses the complete HTTP shell once.
  // This scenario takes ~6s on the validation host, including three cold worker attachments.
  it("routes ordinary and durable calls from one response", async () => {
    await runMixedRoutingScenario("http");
  }, 10_000);
});
