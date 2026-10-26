import { CalculatorParametersSchema } from "./schemas/calculator.ts";
import { createTool } from "@sweatpants/agent-sdk";

export const calculator = createTool("calculator")
  .description("Evaluate a mathematical expression")
  .parameters(CalculatorParametersSchema)
  .execute(function* (params) {
    try {
      const sanitized = params.expression.replace(/[^0-9+\-*/().%\s]/g, "");
      if (sanitized !== params.expression) {
        return {
          expression: params.expression,
          error: "Invalid characters in expression",
          result: null,
        };
      }

      // eslint-disable-next-line no-eval
      const result = eval(sanitized);

      return {
        expression: params.expression,
        result: typeof result === "number" ? result : null,
        error: null,
      };
    } catch (e) {
      return {
        expression: params.expression,
        result: null,
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }
  });
