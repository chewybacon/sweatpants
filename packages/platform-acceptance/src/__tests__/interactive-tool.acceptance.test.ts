import { describe, expect, it } from "vitest";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  CALL_ID,
  createAcceptanceApplication,
  NESTED_SAMPLE_PROMPT_MARKER,
  NESTED_SAMPLE_RESPONSE_MARKER,
  OUTER_TERMINAL_TEXT,
  TOOL_RESULT_MARKER,
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

async function runInteractiveToolScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation({
        initialToolChoice: "required",
      });
      const turn = yield* conversation.send(
        "Book a flight from NYC to LAX using the available tool.",
      );
      const outerRequest = yield* s.model.request({
        model: ACCEPTANCE_MODEL_ID,
        stream: true,
      });
      expect(outerRequest.pullId).not.toBe("");
      expect(records(outerRequest.body.tools)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "function", name: ACCEPTANCE_TOOL_NAME }),
        ]),
      );
      yield* outerRequest.respond.toolCalls([
        {
          id: CALL_ID,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);

      const pickFlight = yield* turn.elicit("pickFlight");
      yield* pickFlight.accept({ flightId: "FL001" });
      const pickSeat = yield* turn.elicit("pickSeat");
      yield* pickSeat.accept({ row: 1, seat: "A" });

      const nestedSample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input ?? [])).toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      expect(nestedSample.pullId).not.toBe("");
      expect(nestedSample.pullId).not.toBe(outerRequest.pullId);
      yield* nestedSample.respond.text(`${NESTED_SAMPLE_RESPONSE_MARKER} Use the airport train.`);

      const finalRequest = yield* s.model.request({
        model: ACCEPTANCE_MODEL_ID,
        stream: true,
      });
      const finalInput = records(finalRequest.body.input);
      expect(finalInput).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call",
            call_id: CALL_ID,
            name: ACCEPTANCE_TOOL_NAME,
          }),
          expect.objectContaining({ type: "function_call_output", call_id: CALL_ID }),
        ]),
      );
      const toolOutput = finalInput.find(
        (item) => item["type"] === "function_call_output" && item["call_id"] === CALL_ID,
      );
      const outputText =
        typeof toolOutput?.["output"] === "string"
          ? toolOutput["output"]
          : JSON.stringify(toolOutput?.["output"] ?? "");
      expect(outputText).toContain(TOOL_RESULT_MARKER);
      expect(outputText).toContain('"isMainThread":false');
      expect(outputText).toContain('"messagesBeforeSample":4');
      expect(outputText).toContain('"messagesAfterSample":6');

      yield* finalRequest.respond.text(OUTER_TERMINAL_TEXT);
      const transcript = yield* turn.settled();
      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toContain("OUTER_TERMINAL_V1");
    },
  );
}

async function runDuplicateElicitScenario(binding: Binding): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation();
      const turn = yield* conversation.send("DUPLICATE_ELICIT_V1");
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "duplicate-elicit-call",
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);
      const elicit = yield* turn.elicit("pickFlight");
      yield* elicit.decline();
      try {
        yield* elicit.decline();
        throw new Error("duplicate elicitation response unexpectedly succeeded");
      } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).toMatch(/already answered/);
      }
      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* finalRequest.respond.text("DUPLICATE_ELICIT_TERMINAL_V1");
      expect((yield* turn.settled()).text).toBe("DUPLICATE_ELICIT_TERMINAL_V1");
      expect(s.model.requests()).toHaveLength(2);
    },
  );
}

async function runElicitOutcomeScenario(
  binding: Binding,
  action: "decline" | "cancel",
): Promise<void> {
  await withTestScenario(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    function* (s) {
      const conversation = s.conversation({
        initialToolChoice: "required",
      });
      const turn = yield* conversation.send(`ELICIT_${action.toUpperCase()}_V1`);
      const outerRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outerRequest.respond.toolCalls([
        {
          id: CALL_ID,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);
      const pickFlight = yield* turn.elicit("pickFlight");
      yield* pickFlight[action]();

      const finalRequest = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const output = records(finalRequest.body.input).find(
        (item) => item["type"] === "function_call_output" && item["call_id"] === CALL_ID,
      );
      expect(JSON.stringify(output)).toContain("flight_not_selected");
      yield* finalRequest.respond.text(`ELICIT_${action.toUpperCase()}_TERMINAL_V1`);
      const transcript = yield* turn.settled();
      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toBe(`ELICIT_${action.toUpperCase()}_TERMINAL_V1`);
    },
  );
}

describe("interactive tool semantics", () => {
  const binding: Binding = "in-process";

  it("controls tool call, two elicitations, nested sample, and final response", async () => {
    await runInteractiveToolScenario(binding);
  }, 30_000);

  it.each(["decline", "cancel"] as const)(
    "delivers a structured %s outcome and completes the outer turn",
    async (action) => {
      await runElicitOutcomeScenario(binding, action);
    },
    30_000,
  );

  it("rejects a duplicate elicitation response without resuming twice", async () => {
    await runDuplicateElicitScenario(binding);
  }, 30_000);

  // binding-conformance: one complete interactive flow crosses the HTTP shell.
  it("completes the full interactive flow over HTTP", async () => {
    await runInteractiveToolScenario("http");
  }, 30_000);
});
