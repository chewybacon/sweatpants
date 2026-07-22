import type { ComponentType } from "react";
import { getElicitContext, makePlugin } from "@sweatpants/framework/chat";
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
      const result = yield* context.render(FlightChoice, {
        flights: elicit.flights,
        message: request.message,
      });
      return { action: "accept", content: result };
    },
  })
  .build();
