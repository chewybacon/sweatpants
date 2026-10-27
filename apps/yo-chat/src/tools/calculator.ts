import { createTool } from "@sweatpants/agent-sdk";
import { calculator as portableCalculator } from "./primitive/calculator.ts";

/** Ordinary placement; the arithmetic body is authored once. */
export const calculator = createTool(portableCalculator.name)
  .description(portableCalculator.description)
  .parameters(portableCalculator.parameters)
  .execute(function* (input) {
    return yield* portableCalculator.invokeWith(input, "calculator", function* (request) {
      throw new Error(`Unexpected calculator capability: ${request.kind}`);
    });
  });
