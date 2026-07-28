import { createContext, type Operation, type Stream } from "effection";
import { definePort } from "@sweatpants/foundation/port";
import type {
  Context,
  Model,
  StreamEvent,
  StreamOptions,
  AssistantMessage,
} from "./runtime/types.ts";

export interface ModelProviderStreamRequest {
  model: Model;
  context: Context;
  options?: StreamOptions;
}

export interface ModelProviderSampleRequest {
  model: Model;
  context: Context;
  options?: StreamOptions;
}

export interface ModelProviderDriver {
  stream(request: ModelProviderStreamRequest): Operation<Stream<StreamEvent, AssistantMessage>>;
  sample(request: ModelProviderSampleRequest): Operation<AssistantMessage>;
}

export class ModelProviderUnavailable extends Error {
  readonly code = "model_provider_unavailable";
  constructor() {
    super("Model provider not configured. Install a ModelProviderDriver in scope.");
    this.name = "ModelProviderUnavailable";
  }
}

/**
 * Model inference as a port.
 *
 * Scenarios install scripted drivers and wrap this seam with middleware to
 * inject latency, faults, and request assertions without touching call sites.
 */
export const ModelProviderPort = definePort<ModelProviderDriver>("model-provider", {
  *stream(_request: ModelProviderStreamRequest): Operation<Stream<StreamEvent, AssistantMessage>> {
    throw new ModelProviderUnavailable();
  },
  *sample(_request: ModelProviderSampleRequest): Operation<AssistantMessage> {
    throw new ModelProviderUnavailable();
  },
});

export const ModelProviderApi = ModelProviderPort.api;

/** Installs one model provider adapter for the calling scope. */
export function installModelProvider(driver: ModelProviderDriver): Operation<void> {
  return ModelProviderPort.installDriver(driver);
}
export const ModelProviderModelContext = createContext<Model>("ModelProviderModel");
export const ModelProviderStreamOptionsContext = createContext<StreamOptions>(
  "ModelProviderStreamOptions",
);

/**
 * Model selection and stream options stay Contexts: they are request-scoped
 * configuration values, not effectful boundaries with swappable drivers.
 */
export function* useModel(): Operation<Model> {
  const model = yield* ModelProviderModelContext.get();
  if (!model) {
    // Installers configure the driver and the model together, so a missing
    // model reports the same root cause the driver seam would.
    throw new Error(
      "Model provider not configured: no model selected. Install a model provider in scope.",
    );
  }
  return model;
}

export function* useStreamOptions(): Operation<StreamOptions | undefined> {
  return yield* ModelProviderStreamOptionsContext.get();
}
