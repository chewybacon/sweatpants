import type {
  Context,
  TranscriptContext,
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
  /** Restore native history details before normalization and usage validation.
   * Synchronous, selected at construction; must preserve message roles/order.
   * The returned context is snapshotted. Do not transform history in stream(). */
  readonly prepareContext?: (context: Context) => Context;
  /** SDK streamSimple driver from the host-owned model registry.
   * Must honor signal abortion and release pending iterator reads so return() can join. */
  readonly stream: (
    model: Model<string>,
    context: TranscriptContext,
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
