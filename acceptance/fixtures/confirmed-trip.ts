import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";

export const CONFIRMED_TRIP_TOOL_NAME = "confirm_trip";
export const CONFIRMED_TRIP_RESULT_MARKER = "CONFIRMED_TRIP";

export const confirmedTrip = createTool(CONFIRMED_TRIP_TOOL_NAME)
  .description("Choose and confirm a flight in one elicitation")
  .parameters(z.object({ route: z.string() }))
  .elicits({
    chooseFlight: {
      context: z.object({ flights: z.array(z.string()) }),
      response: z
        .object({ flightId: z.string(), confirmed: z.boolean() })
        .transform((value) => ({ ...value, normalized: true as const })),
      responseProjections: {
        inputProjection: {
          type: "object",
          properties: { flightId: { type: "string" }, confirmed: { type: "boolean" } },
          required: ["flightId", "confirmed"],
        },
        outputProjection: {
          type: "object",
          properties: {
            flightId: { type: "string" },
            confirmed: { type: "boolean" },
            normalized: { const: true },
          },
          required: ["flightId", "confirmed", "normalized"],
        },
      },
    },
  })
  .execute(function* (params, ctx) {
    const selected = yield* ctx.elicit("chooseFlight", {
      message: `Choose a flight for ${params.route}`,
      context: { flights: ["FL-1", "FL-2"] },
    });
    if (selected.action !== "accept") {
      return { marker: CONFIRMED_TRIP_RESULT_MARKER, selected: "none" };
    }
    return {
      marker: CONFIRMED_TRIP_RESULT_MARKER,
      selected: selected.content.flightId,
      confirmed: selected.content.confirmed,
      normalized: selected.content.normalized,
      route: params.route,
    };
  });
