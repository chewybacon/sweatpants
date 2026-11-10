import type { ContextTokenCount, Json } from "@sweatpan.ts/providers";
import type {
  Context,
  Model,
  SimpleStreamOptions,
  ImageModel,
  ImagesContext,
  ImagesOptions,
} from "@earendil-works/pi-ai";

/** SDK event source. Values are validated at the adapter boundary, including terminal results. */
export interface PiAiStream extends AsyncIterable<unknown> {
  /** Resolves to the SDK's final assistant message after iteration finishes. */
  result(): Promise<unknown>;
}

/** Host-owned selection and SDK configuration, never journal request data. */
export interface PiAiProviderOptions {
  /** Resolved SDK model. Host assembly must pin its selection for durable use. */
  readonly model: Model<string>;
  /** Optional credential; default SDK resolution applies when absent. */
  readonly apiKey?: string;
  /** SDK streamSimple driver from the host-owned model registry.
   * Must honor signal abortion and release pending iterator reads so return() can join. */
  readonly stream: (
    model: Model<string>,
    context: Context,
    options: SimpleStreamOptions,
  ) => PiAiStream;
}

/** Separate image model and operation; never silently route chat to image generation. */
export interface PiAiImageProviderOptions {
  readonly model: ImageModel<string>;
  readonly apiKey?: string;
  /** Host registry driver; must honor the supplied abort signal. */
  readonly generate: (
    model: ImageModel<string>,
    context: ImagesContext,
    options: ImagesOptions,
  ) => Promise<unknown>;
}

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
