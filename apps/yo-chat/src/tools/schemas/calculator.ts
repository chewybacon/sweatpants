import { z } from "zod";
export const CalculatorParametersSchema = z.object({
  expression: z.string().describe("The mathematical expression to evaluate"),
});
