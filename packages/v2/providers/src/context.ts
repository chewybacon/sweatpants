import type { ContextBudget, ContextTokenCount, ModelInfo } from "./contracts.ts";

/** Account for a caller-supplied count of this exact request, including tools/media.
 * No tokenizer, history truncation, billing accumulator or implicit output reserve. */
export function measureContextBudget(
  model: Pick<ModelInfo, "contextWindow" | "maxOutputTokens">,
  input: ContextTokenCount,
  reservedOutput: number,
): ContextBudget {
  for (const value of [input.tokens, reservedOutput, model.contextWindow, model.maxOutputTokens]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("Token counts and limits must be nonnegative safe integers");
    }
  }
  const remaining =
    model.contextWindow === null ? null : model.contextWindow - input.tokens - reservedOutput;
  const outputFits =
    model.maxOutputTokens === null ? null : reservedOutput <= model.maxOutputTokens;
  return {
    input: { ...input },
    reservedOutput,
    contextWindow: model.contextWindow,
    remaining,
    fits:
      outputFits === false || (remaining !== null && remaining < 0)
        ? false
        : remaining === null || outputFits === null
          ? null
          : true,
  };
}
