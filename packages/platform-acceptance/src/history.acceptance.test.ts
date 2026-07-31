import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  normalizeResponsesHistory,
  withTestScenario,
  type TestRigOptions,
} from "@sweatpants/test-rig";
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
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conv = s.conversation({
        tools: [acceptanceBookingTool],
        enabledTools: true,
        initialToolChoice: "required",
      });
      // ── Turn 1: booking with two elicitations and one nested sample ──
      const turn1 = yield* conv.send("Book NYC to LAX with the available tool.");

      const initial = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* initial.respond.toolCalls([
        {
          id: CALL_ID,
          name: ACCEPTANCE_TOOL_NAME,
          arguments: { from: "NYC", destination: "LAX" },
        },
      ]);

      const pickFlight = yield* turn1.elicit("pickFlight");
      yield* pickFlight.accept({ flightId: "FL001" });

      const pickSeat = yield* turn1.elicit("pickSeat");
      yield* pickSeat.accept({ row: 1, seat: "A" });

      const nested = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
      });
      yield* nested.respond.text(`${NESTED_SAMPLE_RESPONSE_MARKER} Use the train.`);

      const final = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* final.respond.text(OUTER_TERMINAL_TEXT);
      yield* turn1.settled();

      // ── Turn 2: what history does the framework put on the wire? ──
      const turn2 = yield* conv.send("FOLLOW_UP_V1 What route did I book?");
      const followUp = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      const history = normalizeResponsesHistory(followUp.body.input);

      // Nested sample traffic must not leak into outer history.
      const outerRecords = history.filter(
        (record) => record.type === "user_text" || record.type === "assistant_text",
      );
      const serializedOuterText = JSON.stringify(outerRecords);
      expect(serializedOuterText).not.toContain(NESTED_SAMPLE_PROMPT_MARKER);
      expect(serializedOuterText).not.toContain(NESTED_SAMPLE_RESPONSE_MARKER);

      // Completed call/result pairs survive in causal order.
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

      // Original tool-call arguments are preserved verbatim.
      const priorCall = history.find(
        (record) => record.type === "assistant_tool_call" && record.callId === CALL_ID,
      );
      expect(priorCall).toMatchObject({ arguments: { from: "NYC", destination: "LAX" } });
      if (!priorCall || priorCall.type !== "assistant_tool_call") {
        throw new Error("missing prior route-bearing tool call");
      }
      // Arguments arrive open from the model; the consumer that needs an
      // object is the one that proves it.
      const priorArguments = z.record(z.string(), z.json()).parse(priorCall.arguments);
      expect({
        from: priorArguments["destination"],
        destination: priorArguments["from"],
      }).toEqual({ from: "LAX", destination: "NYC" });

      yield* followUp.respond.text("You booked NYC to LAX; return is LAX to NYC.");
      const secondTranscript = yield* turn2.settled();
      expect(secondTranscript.text).toBe("You booked NYC to LAX; return is LAX to NYC.");
    },
  );
}

describe("history semantics", () => {
  it("preserves outer tool history and excludes nested sample text", async () => {
    await runHistoryScenario("in-process");
  }, 30_000);
});
