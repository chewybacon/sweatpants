import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";

export const REACT_BOOKING_TOOL_NAME = "react_acceptance_booking";
export const REACT_BOOKING_RESULT_MARKER = "REACT_BOOKING_RESULT_V1";

export const reactBookingTool = createTool(REACT_BOOKING_TOOL_NAME)
  .description("React hook projection acceptance fixture")
  .parameters(z.object({ route: z.string() }))
  .elicits({
    chooseFlight: {
      context: z.object({ flights: z.array(z.string()) }),
      response: z.object({ flightId: z.string() }),
    },
  })
  .execute(function* (params, ctx) {
    const selected = yield* ctx.elicit("chooseFlight", {
      message: `Choose a flight for ${params.route}`,
      context: { flights: ["FL-REACT-1", "FL-REACT-2"] },
    });
    if (selected.action !== "accept") {
      return { marker: REACT_BOOKING_RESULT_MARKER, selected: "none" };
    }
    return {
      marker: REACT_BOOKING_RESULT_MARKER,
      selected: selected.content.flightId,
      route: params.route,
    };
  });
