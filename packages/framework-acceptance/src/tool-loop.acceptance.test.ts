import { describe, expect, it } from "vitest";
import { withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_IMMEDIATE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_TOOL_RESULT_MARKER,
  IMMEDIATE_RESULT_MARKER,
  acceptanceDurableTool,
  acceptanceImmediateTool,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

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
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const requestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({
        tools: [acceptanceImmediateTool],
        enabledTools: true,
        initialToolChoice: "required",
      });
      const turn = conversation.send("MULTI_TOOL_V1");
      const request = await requestPromise;
      const finalPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await request.respond.toolCalls([
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

      const finalRequest = await finalPromise;
      const outputs = records(finalRequest.body.input).filter(
        (item) => item["type"] === "function_call_output",
      );
      expect(outputs).toHaveLength(2);
      expect(outputs.map((item) => item["call_id"])).toEqual(["multi-call-1", "multi-call-2"]);
      expect(JSON.stringify(outputs)).toContain(IMMEDIATE_RESULT_MARKER);
      expect(JSON.stringify(outputs)).toContain("alpha");
      expect(JSON.stringify(outputs)).toContain("beta");

      await finalRequest.respond.text("MULTI_TOOL_TERMINAL_V1");
      expect((await turn.complete()).text).toBe("MULTI_TOOL_TERMINAL_V1");
    },
  );
}

async function runMixedRoutingScenario(binding: Binding): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const requestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({
        tools: [acceptanceImmediateTool, acceptanceDurableTool],
      });
      const turn = conversation.send("MIXED_ROUTING_V1");
      const nestedPromise = rig.model.expectRequest((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      const elicitPromise = turn.expectElicit("chooseOption");
      await (
        await requestPromise
      ).respond.toolCalls([
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
      await (await nestedPromise).respond.text("mixed durable note");
      const finalPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await (await elicitPromise).accept({ selected: "mixed-alpha" });
      const finalRequest = await finalPromise;
      const outputs = records(finalRequest.body.input).filter(
        (item) => item["type"] === "function_call_output",
      );
      expect(outputs.map((item) => item["call_id"])).toEqual([
        "mixed-ordinary-call",
        "mixed-durable-call",
      ]);
      expect(JSON.stringify(outputs)).toContain(IMMEDIATE_RESULT_MARKER);
      expect(JSON.stringify(outputs)).toContain(DURABLE_TOOL_RESULT_MARKER);
      await finalRequest.respond.text("MIXED_ROUTING_TERMINAL_V1");
      expect((await turn.complete()).text).toBe("MIXED_ROUTING_TERMINAL_V1");
    },
  );
}

async function runTextThenToolScenario(binding: Binding): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const requestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({ tools: [acceptanceImmediateTool] });
      const turn = conversation.send("TEXT_THEN_TOOL_V1");
      const preface = turn.expectTextDelta("TOOL_PREFACE_V1");
      const finalPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await (
        await requestPromise
      ).respond.textAndToolCalls("TOOL_PREFACE_V1", [
        {
          id: "text-tool-call",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "after-text", behavior: "complete" },
        },
      ]);
      await preface;
      const finalRequest = await finalPromise;
      expect(JSON.stringify(finalRequest.body.input)).toContain("TOOL_PREFACE_V1");
      expect(JSON.stringify(finalRequest.body.input)).toContain("text-tool-call");
      await finalRequest.respond.text("TEXT_THEN_TOOL_TERMINAL_V1");
      const transcript = await turn.complete();
      expect(transcript.text).toContain("TOOL_PREFACE_V1");
      expect(transcript.text).toContain("TEXT_THEN_TOOL_TERMINAL_V1");
    },
  );
}

async function runChunkedArgumentsScenario(binding: Binding): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const requestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({ tools: [acceptanceImmediateTool] });
      const turn = conversation.send("CHUNKED_ARGUMENTS_V1");
      const request = await requestPromise;
      const finalPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await request.respond.toolCalls(
        [
          {
            id: "chunked-call-1",
            name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
            arguments: { value: "chunked", behavior: "complete" },
          },
        ],
        { argumentChunkSize: 2 },
      );
      const finalRequest = await finalPromise;
      expect(JSON.stringify(finalRequest.body.input)).toContain("chunked");
      await finalRequest.respond.text("CHUNKED_ARGUMENTS_TERMINAL_V1");
      expect((await turn.complete()).text).toBe("CHUNKED_ARGUMENTS_TERMINAL_V1");
    },
  );
}

async function runMixedSuccessFailure(binding: Binding): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const requestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({ tools: [acceptanceImmediateTool] });
      const turn = conversation.send("MIXED_SUCCESS_FAILURE_V1");
      await (
        await requestPromise
      ).respond.toolCalls([
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
      await expect(turn.complete()).rejects.toThrow();

      const recoveryPromise = rig.model.expectRequest((request) => {
        const input = JSON.stringify(request.body.input);
        expect(input).toContain("MIXED_SUCCESS_FAILURE_RECOVERY_V1");
        expect(input).toContain("mixed-success-call");
        expect(input).toContain("mixed-failure-call");
        expect(input).toContain(IMMEDIATE_RESULT_MARKER);
        expect(input).toMatch(/error|fail/i);
      });
      const recovery = conversation.send("MIXED_SUCCESS_FAILURE_RECOVERY_V1");
      await (await recoveryPromise).respond.text("MIXED_SUCCESS_FAILURE_RECOVERED_V1");
      expect((await recovery.complete()).text).toBe("MIXED_SUCCESS_FAILURE_RECOVERED_V1");
    },
  );
}

async function runTerminalToolFailure(
  binding: Binding,
  failure: "throw" | "invalid_output" | "invalid_arguments" | "unknown" | "malformed",
): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const requestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({ tools: [acceptanceImmediateTool] });
      const turn = conversation.send(`TOOL_FAILURE_${failure.toUpperCase()}_V1`);
      const request = await requestPromise;

      if (failure === "malformed") {
        await request.respond.malformedToolCall({
          id: "failure-call",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: "{not-json",
        });
      } else {
        await request.respond.toolCalls([
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

      await expect(turn.complete()).rejects.toThrow();
      expect(
        conversation.transcript().events.filter((event) => event.type === "RUN_ERROR"),
      ).toHaveLength(1);

      // A failed tool turn must not make the conversation unusable.
      const recoveryPromise = rig.model.expectRequest((recoveryRequest) => {
        const input = JSON.stringify(recoveryRequest.body.input);
        expect(input).toContain(`RECOVER_TOOL_FAILURE_${failure.toUpperCase()}_V1`);
        expect(input).toContain("failure-call");
        expect(input).toMatch(/error|fail|invalid|unknown/i);
      });
      const recovery = conversation.send(`RECOVER_TOOL_FAILURE_${failure.toUpperCase()}_V1`);
      await (await recoveryPromise).respond.text(`RECOVERED_${failure.toUpperCase()}_V1`);
      expect((await recovery.complete()).text).toBe(`RECOVERED_${failure.toUpperCase()}_V1`);
    },
  );
}

async function runSequentialToolScenario(binding: Binding): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const conversation = rig.chat.conversation({ tools: [acceptanceImmediateTool] });
      const firstPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const turn = conversation.send("SEQUENTIAL_TOOL_LOOP_V1");
      const first = await firstPromise;
      const secondPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await first.respond.toolCalls([
        {
          id: "sequential-call-1",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "first", behavior: "complete" },
        },
      ]);
      const second = await secondPromise;
      expect(JSON.stringify(second.body.input)).toContain("sequential-call-1");
      const thirdPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await second.respond.toolCalls([
        {
          id: "sequential-call-2",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "second", behavior: "complete" },
        },
      ]);
      const third = await thirdPromise;
      const serialized = JSON.stringify(third.body.input);
      expect(serialized).toContain("sequential-call-1");
      expect(serialized).toContain("sequential-call-2");
      await third.respond.text("SEQUENTIAL_TOOL_TERMINAL_V1");
      expect((await turn.complete()).text).toBe("SEQUENTIAL_TOOL_TERMINAL_V1");
      expect(rig.model.requests()).toHaveLength(3);
    },
  );
}

async function runIterationLimitScenario(binding: Binding): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication(context) {
        return createAcceptanceApplication(context, undefined, { maxToolIterations: 2 });
      },
    },
    async (rig) => {
      const conversation = rig.chat.conversation({ tools: [acceptanceImmediateTool] });
      const firstPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const turn = conversation.send("MAX_ITERATIONS_V1");
      const first = await firstPromise;
      const secondPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await first.respond.toolCalls([
        {
          id: "iteration-call-1",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "one", behavior: "complete" },
        },
      ]);
      const second = await secondPromise;
      await second.respond.toolCalls([
        {
          id: "iteration-call-2",
          name: ACCEPTANCE_IMMEDIATE_TOOL_NAME,
          arguments: { value: "two", behavior: "complete" },
        },
      ]);
      await expect(turn.complete()).rejects.toThrow(/maximum|max_tool_iterations/i);
      expect(rig.model.requests()).toHaveLength(2);
    },
  );
}

describe.each<Binding>(["in-process", "http"])("tool loop through the %s binding", (binding) => {
  it("correlates two tool calls from one response", async () => {
    await runTwoCallScenario(binding);
  });

  it("routes ordinary and durable calls from one response", async () => {
    await runMixedRoutingScenario(binding);
  });

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
