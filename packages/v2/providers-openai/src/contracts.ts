import type { ContextTokenCount, Json } from "@sweatpan.ts/providers";

/** Explicit-history Responses subset. No server conversation or hidden input state. */
export interface ResponsesCountInput {
  readonly model: string;
  readonly input: string | readonly Json[];
  readonly tools: readonly Json[];
}

export interface ResponsesInputCounterOptions {
  /** API base URL, e.g. https://api.openai.com/v1. Never selected implicitly. */
  readonly endpoint: string;
  /** Host-owned credentials/headers; captured at construction. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Native HTTP adapter. Caller owns abort, timeout and any retry policy. */
export interface ResponsesInputCounter {
  count(input: ResponsesCountInput, signal: AbortSignal): Promise<ContextTokenCount>;
}
