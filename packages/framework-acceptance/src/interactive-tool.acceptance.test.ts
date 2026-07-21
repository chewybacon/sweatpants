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

      await finalRequest.respond.text(OUTER_TERMINAL_TEXT);

      const transcript = await turn.complete();
      expect(transcript.outcome).toBe("success");
      expect(transcript.text).toContain("OUTER_TERMINAL_V1");
    },
  );
}

describe.each<Binding>(["in-process", "http"])(
  "interactive tool through the %s binding",
  (binding) => {
    it("controls tool call, two elicitations, nested sample, and final response", async () => {
      await runInteractiveToolScenario(binding);
    }, 30_000);
  },
);
