import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "effection";
import { describe, expect, it } from "vitest";
import { withTestScenario } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_MODEL_ID,
  ACCEPTANCE_TOOL_NAME,
  NESTED_SAMPLE_PROMPT_MARKER,
  createAcceptanceApplication,
  type AcceptanceApplicationInspection,
} from "../lib/acceptance-app.ts";

describe.each(["in-process", "http"] as const)("execution boundaries over %s", (binding) => {
  it("answers two questions, answers the tool's model request, then returns the booking", async () => {
    await withTestScenario(
      { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
      function* (s) {
        const conversation = s.conversation();
        const booking = yield* conversation.send("Book a flight from New York to Los Angeles.");

        const assistant = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* assistant.respond.toolCalls([
          {
            id: "book-flight",
            name: ACCEPTANCE_TOOL_NAME,
            arguments: { from: "NYC", destination: "LAX" },
          },
        ]);

        const flight = yield* booking.elicit("pickFlight");
        yield* flight.accept({ flightId: "FL001" });
        const seat = yield* booking.elicit("pickSeat");
        yield* seat.accept({ row: 2, seat: "A" });

        const travelTip = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        expect(JSON.stringify(travelTip.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
        yield* travelTip.respond.text("Arrive two hours before departure.");

        const summary = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        expect(summary.body.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              call_id: "book-flight",
              output: expect.stringContaining("TKT-ACCEPTANCE-1"),
            }),
          ]),
        );
        const history = JSON.stringify(summary.body.input);
        expect(history).toContain("2A");
        expect(history).toContain("Arrive two hours before departure.");
        yield* summary.respond.text("Your flight is booked, seat 2A.");

        const completed = yield* booking.settled();
        expect(completed.text).toBe("Your flight is booked, seat 2A.");
        expect(s.model.requests()).toHaveLength(3);
      },
    );
  }, 30_000);

  it("returns a failure after the second answer and allows the conversation to continue", async () => {
    await withTestScenario(
      { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
      function* (s) {
        const conversation = s.conversation();
        const booking = yield* conversation.send("Book a flight to Los Angeles.");

        const assistant = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* assistant.respond.toolCalls([
          {
            id: "failed-booking",
            name: ACCEPTANCE_TOOL_NAME,
            arguments: { from: "NYC", destination: "LAX", behavior: "throw_after_resume" },
          },
        ]);

        const flight = yield* booking.elicit("pickFlight");
        yield* flight.accept({ flightId: "FL001" });
        const seat = yield* booking.elicit("pickSeat");
        yield* seat.accept({ row: 2, seat: "A" });

        const failureSummary = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        expect(failureSummary.body.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              call_id: "failed-booking",
              output: expect.stringMatching(/error|fail/i),
            }),
          ]),
        );
        yield* failureSummary.respond.text("The booking failed.");
        const failedBooking = yield* booking.settled();
        expect(failedBooking.text).toBe("The booking failed.");

        const followUp = yield* conversation.send("What can we try next?");
        const nextAssistant = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* nextAssistant.respond.text("We can choose another flight.");
        const continued = yield* followUp.settled();
        expect(continued.text).toBe("We can choose another flight.");
      },
    );
  }, 30_000);

  it("reconnects at the second question without repeating the first answer", async () => {
    await withTestScenario(
      { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
      function* (s) {
        const conversation = s.conversation();
        const booking = yield* conversation.send("Book a flight to Los Angeles.");
        const assistant = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* assistant.respond.toolCalls([
          {
            id: "reconnected-booking",
            name: ACCEPTANCE_TOOL_NAME,
            arguments: { from: "NYC", destination: "LAX" },
          },
        ]);

        const flight = yield* booking.elicit("pickFlight");
        yield* flight.accept({ flightId: "FL001" });
        const seat = yield* booking.elicit("pickSeat");

        const reconnected = yield* conversation.reopen();
        const resumedBooking = reconnected.resumePendingElicit("pickSeat");
        const recoveredSeat = yield* resumedBooking.elicit("pickSeat");
        expect(recoveredSeat.elicitId).toBe(seat.elicitId);
        expect(s.model.requests()).toHaveLength(1);
        yield* recoveredSeat.accept({ row: 4, seat: "B" });

        const travelTip = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        expect(JSON.stringify(travelTip.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);
        yield* travelTip.respond.text("Bring a book.");

        const summary = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        expect(summary.body.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              call_id: "reconnected-booking",
              output: expect.stringContaining("4B"),
            }),
          ]),
        );
        expect(JSON.stringify(summary.body.input)).toContain("FL001");
        yield* summary.respond.text("Booked, seat 4B.");
        const completed = yield* resumedBooking.settled();
        expect(completed.text).toBe("Booked, seat 4B.");
        expect(s.model.requests()).toHaveLength(3);
      },
    );
  }, 30_000);

  it("cancels a pending model request, releases the worker invocation, and accepts a new task", async () => {
    let inspection: AcceptanceApplicationInspection;
    await withTestScenario(
      {
        binding,
        modelId: ACCEPTANCE_MODEL_ID,
        createApplication(context) {
          return createAcceptanceApplication(context, (created) => {
            inspection = created;
          });
        },
      },
      function* (s) {
        const conversation = s.conversation();
        const booking = yield* conversation.send("Book a flight to Los Angeles.");
        const assistant = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* assistant.respond.toolCalls([
          {
            id: "cancelled-booking",
            name: ACCEPTANCE_TOOL_NAME,
            arguments: { from: "NYC", destination: "LAX" },
          },
        ]);

        const flight = yield* booking.elicit("pickFlight");
        yield* flight.accept({ flightId: "FL001" });
        const seat = yield* booking.elicit("pickSeat");
        yield* seat.accept({ row: 2, seat: "A" });
        const travelTip = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        expect(JSON.stringify(travelTip.body.input)).toContain(NESTED_SAMPLE_PROMPT_MARKER);

        const providerStopped = yield* spawn(() => travelTip.respond.awaitAbort());
        yield* booking.cancel();
        yield* providerStopped;
        yield* booking.failure();

        const runtime = inspection!.toolInvocationRuntime;
        if (!runtime) {
          throw new Error("Expected the worker-backed invocation runtime");
        }
        yield* runtime.drained();
        expect(runtime.activeIds()).toEqual([]);

        const followUp = yield* conversation.send("Let's plan something else.");
        const nextAssistant = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
        yield* nextAssistant.respond.text("What would you like to plan?");
        const continued = yield* followUp.settled();
        expect(continued.text).toBe("What would you like to plan?");
      },
    );
  }, 30_000);

  it("reports worker loss without repeating an unacknowledged operation and accepts a new task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worker-loss-"));
    const evidencePath = join(directory, "attempts.txt");
    try {
      await withTestScenario(
        { binding, modelId: ACCEPTANCE_MODEL_ID, createApplication: createAcceptanceApplication },
        function* (s) {
          const conversation = s.conversation();
          const booking = yield* conversation.send("Book a flight to Los Angeles.");
          const assistant = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
          yield* assistant.respond.toolCalls([
            {
              id: "lost-booking",
              name: ACCEPTANCE_TOOL_NAME,
              arguments: {
                from: "NYC",
                destination: "LAX",
                behavior: "crash_after_resume",
                crashEvidencePath: evidencePath,
              },
            },
          ]);

          const flight = yield* booking.elicit("pickFlight");
          yield* flight.accept({ flightId: "FL001" });
          const seat = yield* booking.elicit("pickSeat");
          yield* seat.accept({ row: 2, seat: "A" });

          const failureSummary = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
          expect(failureSummary.body.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "function_call_output",
                call_id: "lost-booking",
                output: expect.stringContaining("operation outcome is unknown"),
              }),
            ]),
          );
          yield* failureSummary.respond.text("The worker stopped before confirming the booking.");
          const interrupted = yield* booking.settled();
          expect(interrupted.text).toBe("The worker stopped before confirming the booking.");

          const followUp = yield* conversation.send("What can we do next?");
          const nextAssistant = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
          yield* nextAssistant.respond.text("Check the booking before trying again.");
          const continued = yield* followUp.settled();
          expect(continued.text).toBe("Check the booking before trying again.");
          expect(s.model.requests()).toHaveLength(3);
        },
      );
      expect(await readFile(evidencePath, "utf8")).toBe("booking-attempt\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
