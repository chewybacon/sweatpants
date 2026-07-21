import { describe, expect, it } from "vitest";
import { normalizeResponsesHistory, withTestRig, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  CALL_ID,
  createAcceptanceApplication,
  NESTED_SAMPLE_PROMPT_MARKER,
  NESTED_SAMPLE_RESPONSE_MARKER,
  OUTER_TERMINAL_TEXT,
  acceptanceBookingTool,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

async function runHistoryScenario(binding: Binding): Promise<void> {
  await withTestRig(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    async (rig) => {
      const initialRequestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const conversation = rig.chat.conversation({
        tools: [acceptanceBookingTool],
        enabledTools: true,
        initialToolChoice: "required",
      });
      const firstTurn = conversation.send("Book NYC to LAX with the available tool.");
      const pickFlightPromise = firstTurn.expectElicit("pickFlight");
      const pickSeatPromise = firstTurn.expectElicit("pickSeat");

      const initialRequest = await initialRequestPromise;
      const nestedRequestPromise = rig.model.expectRequest((request) => {
        expect(JSON.stringify(request.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      await initialRequest.respond.toolCalls([
        {
          id: CALL_ID,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);

      await (await pickFlightPromise).accept({ flightId: "FL001" });
      await (await pickSeatPromise).accept({ row: 1, seat: "A" });

      const nestedRequest = await nestedRequestPromise;
      const finalRequestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      await nestedRequest.respond.text(`${NESTED_SAMPLE_RESPONSE_MARKER} Use the train.`);
      const finalRequest = await finalRequestPromise;
      await finalRequest.respond.text(OUTER_TERMINAL_TEXT);
      await firstTurn.complete();

      const followUpRequestPromise = rig.model.expectRequest({ model: ACCEPTANCE_MODEL_ID });
      const secondTurn = conversation.send("FOLLOW_UP_V1 What route did I book?");
      const followUpRequest = await followUpRequestPromise;
      const history = normalizeResponsesHistory(followUpRequest.body.input);

      const outerRecords = history.filter(
        (record) => record.type === "user_text" || record.type === "assistant_text",
      );
      const serializedOuterText = JSON.stringify(outerRecords);
      expect(serializedOuterText).not.toContain(NESTED_SAMPLE_PROMPT_MARKER);
      expect(serializedOuterText).not.toContain(NESTED_SAMPLE_RESPONSE_MARKER);

      const required = history.filter((record) => {
        if (record.type === "user_text") {
          return record.text.includes("Book NYC to LAX") || record.text.includes("FOLLOW_UP_V1");
        }
        if (record.type === "assistant_text") {
          return record.text.includes("OUTER_TERMINAL_V1");
        }
        return record.type === "assistant_tool_call" || record.type === "tool_result";
      });
      expect(required).toEqual([
        { type: "user_text", text: "Book NYC to LAX with the available tool." },
        {
          type: "assistant_tool_call",
          callId: CALL_ID,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
        expect.objectContaining({ type: "tool_result", callId: CALL_ID }),
        { type: "assistant_text", text: OUTER_TERMINAL_TEXT },
        { type: "user_text", text: "FOLLOW_UP_V1 What route did I book?" },
      ]);

      await followUpRequest.respond.text("You booked NYC to LAX.");
      const secondTranscript = await secondTurn.complete();
      expect(secondTranscript.text).toBe("You booked NYC to LAX.");
    },
  );
}

describe.each<Binding>(["in-process", "http"])("history through the %s binding", (binding) => {
  it("preserves outer tool history and excludes nested sample text", async () => {
    await runHistoryScenario(binding);
  }, 30_000);
});
