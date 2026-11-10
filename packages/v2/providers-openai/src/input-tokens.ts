import type { ResponsesInputCounter, ResponsesInputCounterOptions } from "./contracts.ts";

/** No IO at construction. One count call owns one HTTP request, never inference. */
export function createResponsesInputCounter(
  options: ResponsesInputCounterOptions,
): ResponsesInputCounter {
  const url = `${options.endpoint.replace(/\/$/, "")}/responses/input_tokens`;
  const headers = { ...options.headers, "Content-Type": "application/json" };
  return {
    async count(input, signal) {
      signal.throwIfAborted();
      if (
        Object.keys(input).some((key) => !["model", "input", "tools"].includes(key)) ||
        typeof input.model !== "string" ||
        !input.model.trim() ||
        !Array.isArray(input.tools) ||
        !(typeof input.input === "string" || Array.isArray(input.input))
      ) {
        throw new Error("Expected explicit model/input/tools for Responses counting");
      }
      // Serialize before awaiting: later caller mutation cannot change this request.
      const body = JSON.stringify({ model: input.model, input: input.input, tools: input.tools });
      const response = await fetch(url, { method: "POST", headers, body, signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Responses input counting returned HTTP ${response.status}`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("Invalid Responses input token count");
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("object" in value) ||
        value.object !== "response.input_tokens" ||
        !("input_tokens" in value) ||
        typeof value.input_tokens !== "number" ||
        !Number.isSafeInteger(value.input_tokens) ||
        value.input_tokens < 0
      ) {
        throw new Error("Invalid Responses input token count");
      }
      return { tokens: value.input_tokens, kind: "measured" };
    },
  };
}
