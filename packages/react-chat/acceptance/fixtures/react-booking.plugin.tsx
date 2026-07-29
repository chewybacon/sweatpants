import type { ComponentType } from "react";
import { getElicitContext, makePlugin } from "@sweatpants/tool-session/mcp";
import { reactBookingTool } from "./react-booking.tool.ts";

export interface FlightChoiceProps {
  flights: string[];
  message: string;
}

/** Marker component captured by the hook-state acceptance adapter. */
export const FlightChoice: ComponentType<FlightChoiceProps> = () => null;
FlightChoice.displayName = "FlightChoice";

export const reactBookingPlugin = makePlugin(reactBookingTool)
  .onElicit({
    chooseFlight: function* (request, context) {
      const elicit = getElicitContext<{ flights: string[]; [key: string]: unknown }>(request);
      const result = yield* context.render<FlightChoiceProps, { flightId: string }>(FlightChoice, {
        flights: elicit.flights,
        message: request.message,
      });
      return { action: "accept", content: result };
    },
  })
  .build();
