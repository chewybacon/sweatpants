import { describe, expect, it } from "vitest";
import { withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  CALL_ID,
  createAcceptanceApplication,
  NESTED_SAMPLE_PROMPT_MARKER,
  NESTED_SAMPLE_RESPONSE_MARKER,
  OUTER_TERMINAL_TEXT,
  TOOL_RESULT_MARKER,
  acceptanceBookingTool,
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

async function runInteractiveToolScenario(binding: Binding): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    async (rig) => {
      const outerRequestPromise = rig.model.expectRequest({
        model: ACCEPTANCE_MODEL_ID,
        stream: true,
      });

      const conversation = rig.chat.conversation({
        tools: [acceptanceBookingTool],
        enabledTools: true,
        initialToolChoice: "required",
      });
      const turn = conversation.send("Book a flight from NYC to LAX using the available tool.");
      const pickFlightPromise = turn.expectElicit("pickFlight");
      const pickSeatPromise = turn.expectElicit("pickSeat");

      const outerRequest = await outerRequestPromise;
      expect(outerRequest.pullId).not.toBe("");
      expect(records(outerRequest.body.tools)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            name: ACCEPTANCE_TOOL_NAME,
          }),
        ]),
      );

      const nestedSamplePromise = rig.model.expectRequest((request) => {
        const serialized = JSON.stringify(request.body.input ?? []);
        expect(serialized).toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });

      await outerRequest.respond.toolCalls([
        {
          id: CALL_ID,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);

      const pickFlight = await pickFlightPromise;
      await pickFlight.accept({ flightId: "FL001" });

      const pickSeat = await pickSeatPromise;
      await pickSeat.accept({ row: 1, seat: "A" });

      const nestedSample = await nestedSamplePromise;
      expect(nestedSample.pullId).not.toBe("");
      expect(nestedSample.pullId).not.toBe(outerRequest.pullId);

      const finalRequestPromise = rig.model.expectRequest({
        model: ACCEPTANCE_MODEL_ID,
        stream: true,
      });

      await nestedSample.respond.text(`${NESTED_SAMPLE_RESPONSE_MARKER} Use the airport train.`);

      const finalRequest = await finalRequestPromise;
      const finalInput = records(finalRequest.body.input);
      expect(finalInput).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call",
            call_id: CALL_ID,
            name: ACCEPTANCE_TOOL_NAME,
          }),
          expect.objectContaining({
            type: "function_call_output",
            call_id: CALL_ID,
          }),
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

      await finalRequest.respond.text(OUTER_TERMINAL_TEXT);

      const transcript = await turn.complete();
      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toContain("OUTER_TERMINAL_V1");
    },
  );
}

async function runDuplicateElicitScenario(binding: Binding): Promise<void> {
  await withTestRig(
    { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
    async (rig) => {
      const outerPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({ tools: [acceptanceBookingTool] });
      const turn = conversation.send("DUPLICATE_ELICIT_V1");
      const elicitPromise = turn.expectElicit("pickFlight");
      await (
        await outerPromise
      ).respond.toolCalls([
        {
          id: "duplicate-elicit-call",
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);
      const elicit = await elicitPromise;
      await elicit.decline();
      await expect(elicit.decline()).rejects.toThrow(/already answered/);
      const finalRequest = await rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await finalRequest.respond.text("DUPLICATE_ELICIT_TERMINAL_V1");
      expect((await turn.complete()).text).toBe("DUPLICATE_ELICIT_TERMINAL_V1");
      expect(rig.model.requests()).toHaveLength(2);
    },
  );
}

async function runElicitOutcomeScenario(
  binding: Binding,
  action: "decline" | "cancel",
): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
    },
    async (rig) => {
      const outerRequestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({
        tools: [acceptanceBookingTool],
        enabledTools: true,
        initialToolChoice: "required",
      });
      const turn = conversation.send(`ELICIT_${action.toUpperCase()}_V1`);
      const pickFlightPromise = turn.expectElicit("pickFlight");

      const outerRequest = await outerRequestPromise;
      await outerRequest.respond.toolCalls([
        {
          id: CALL_ID,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);

      const pickFlight = await pickFlightPromise;
      const finalRequestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await pickFlight[action]();

      const finalRequest = await finalRequestPromise;
      const output = records(finalRequest.body.input).find(
        (item) => item["type"] === "function_call_output" && item["call_id"] === CALL_ID,
      );
      expect(JSON.stringify(output)).toContain("flight_not_selected");

      await finalRequest.respond.text(`ELICIT_${action.toUpperCase()}_TERMINAL_V1`);
      const transcript = await turn.complete();
      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toBe(`ELICIT_${action.toUpperCase()}_TERMINAL_V1`);
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "interactive tool through the %s binding",
  (binding) => {
    it("controls tool call, two elicitations, nested sample, and final response", async () => {
      await runInteractiveToolScenario(binding);
    }, 30_000);

    it.each(["decline", "cancel"] as const)(
      "delivers a structured %s outcome and completes the outer turn",
      async (action) => {
        await runElicitOutcomeScenario(binding, action);
      },
    );

    it("rejects a duplicate elicitation response without resuming twice", async () => {
      await runDuplicateElicitScenario(binding);
    });
  },
);
