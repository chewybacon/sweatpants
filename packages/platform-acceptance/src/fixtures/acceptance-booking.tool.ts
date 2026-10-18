import { appendFileSync } from "node:fs";
import { isMainThread, threadId } from "node:worker_threads";
import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";

export const ACCEPTANCE_TOOL_NAME = "acceptance_booking";
export const NESTED_SAMPLE_PROMPT_MARKER = "NESTED_SAMPLE_PROMPT_V1";
export const NESTED_SAMPLE_RESPONSE_MARKER = "NESTED_SAMPLE_RESPONSE_V1";
export const TOOL_RESULT_MARKER = "TOOL_RESULT_V1";

const FLIGHTS = [
  { id: "FL001", airline: "SkyHigh", price: 299 },
  { id: "FL002", airline: "CloudAir", price: 349 },
] as const;

/**
 * The one canonical acceptance fixture tool. This module is authored once and
 * executed only inside the worker-backed local tool runtime; the host imports
 * it purely for inventory projection and runtime registration.
 */
export const acceptanceBookingTool = createTool(ACCEPTANCE_TOOL_NAME)
  .description("Deterministic acceptance booking fixture")
  .parameters(
    z.object({
      from: z.string(),
      destination: z.string(),
      crashEvidencePath: z.string().optional(),
      behavior: z
        .enum(["complete", "throw_after_resume", "crash_after_resume"])
        .default("complete"),
    }),
  )
  .elicits({
    pickFlight: {
      response: z.object({ flightId: z.string() }),
    },
    pickSeat: {
      response: z.object({
        row: z.number(),
        seat: z.string(),
      }),
    },
  })
  .samples({ travelTip: { description: "One short deterministic travel tip" } })
  .execute(function* (params, ctx) {
    const flightResult = yield* ctx.elicit("pickFlight", {
      message: `Select a flight from ${params.from} to ${params.destination}`,
    });
    if (flightResult.action !== "accept") {
      return { success: false, reason: "flight_not_selected" };
    }

    const selectedFlight = FLIGHTS.find((flight) => flight.id === flightResult.content.flightId);
    if (!selectedFlight) {
      return { success: false, reason: "invalid_flight" };
    }

    const seatResult = yield* ctx.elicit("pickSeat", {
      message: `Select your seat on ${selectedFlight.airline}`,
    });
    if (seatResult.action !== "accept") {
      return { success: false, reason: "seat_not_selected" };
    }

    if (params.behavior === "crash_after_resume") {
      if (isMainThread || !params.crashEvidencePath) {
        throw new Error("Crash fixture requires a worker and evidence file");
      }
      // Record a stand-in external effect, then die before returning its result.
      appendFileSync(params.crashEvidencePath, "booking-attempt\n");
      process.exit(23);
    }

    const messagesBeforeSample = ctx.messages.length;
    if (params.behavior === "throw_after_resume") {
      throw new Error("planned tool failure after elicitation resume");
    }

    const tip = yield* ctx.sample("travelTip", {
      prompt: `${NESTED_SAMPLE_PROMPT_MARKER} Give a brief travel tip for ${params.destination}`,
    });
    const messagesAfterSample = ctx.messages.length;

    return {
      success: true,
      marker: TOOL_RESULT_MARKER,
      ticketNumber: "TKT-ACCEPTANCE-1",
      flight: selectedFlight,
      seat: `${seatResult.content.row}${seatResult.content.seat}`,
      route: { from: params.from, to: params.destination },
      travelTip: tip.text,
      worker: { isMainThread, threadId, messagesBeforeSample, messagesAfterSample },
    };
  });
