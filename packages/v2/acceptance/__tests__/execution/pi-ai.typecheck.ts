import {
  createPiAiProvider,
  createPiAiImageProvider,
  describePiAiModel,
  type PiAiImageProviderOptions,
  type PiAiProviderOptions,
} from "@sweatpan.ts/providers-pi-ai";
import {
  measureContextBudget,
  type ImageProvider,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
} from "@sweatpan.ts/providers";
import type { Runtime } from "@sweatpan.ts/runtime";

/** Public source and emitted-declaration consumer, including canonical defaults. */
export function piAiConsumer<Y>(runtime: Runtime<Y>, options: PiAiProviderOptions) {
  const provider: ModelProvider<Y> = createPiAiProvider(runtime, options);
  const request: ModelRequest = {
    context: { messages: [{ role: "user", content: "hello" }], tools: [] },
  };
  // @ts-expect-error Credential configuration is not canonical journal request input.
  provider.stream({ ...request, apiKey: "not-a-request-field" });
  return provider.stream(request);
}

/** Image operations and metadata remain usable without importing SDK types. */
export function mediaConsumer<Y>(runtime: Runtime<Y>, options: PiAiImageProviderOptions) {
  const images: ImageProvider<Y> = createPiAiImageProvider(runtime, options);
  return images.generate({ input: [{ type: "text", text: "A mountain" }] });
}
export function contextConsumer(options: PiAiProviderOptions) {
  const info: ModelInfo = describePiAiModel(options.model);
  return measureContextBudget(info, { tokens: 100, kind: "estimated" }, 200);
}
