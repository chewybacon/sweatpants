import type { ComponentType } from "react";
import { makePlugin, type ReactRenderableProps } from "../../src/plugin.ts";
import { reactBookingTool } from "./react-booking.tool.ts";

export interface FlightChoiceProps extends ReactRenderableProps<{ flightId: string }> {
  flights: string[];
  message: string;
}

export interface ConfirmationChoiceProps extends ReactRenderableProps<{ confirmed: boolean }> {
  message: string;
}

/** Marker components captured by the hook-state acceptance adapter. */
export const FlightChoice: ComponentType<FlightChoiceProps> = () => null;
FlightChoice.displayName = "FlightChoice";
export const ConfirmationChoice: ComponentType<ConfirmationChoiceProps> = () => null;
ConfirmationChoice.displayName = "ConfirmationChoice";

export const reactBookingPlugin = makePlugin(reactBookingTool)
  .onElicit({
    chooseFlight: function* (input, context) {
      const result = yield* context.render(FlightChoice, {
        flights: input.context.flights,
        message: input.message,
      });
      const confirmation = yield* context.render(ConfirmationChoice, {
        message: `Confirm ${result.flightId}`,
      });
      return {
        action: "accept",
        content: { ...result, confirmed: confirmation.confirmed },
      };
    },
  })
  .build();
