import {
  createModels,
  createProvider,
  createAssistantMessageEventStream,
  type Model,
  type AssistantMessage,
  type ProviderStreams,
  type ProviderImages,
  type ImageModel,
} from "@earendil-works/pi-ai";
import { run } from "effection";
import { describe, expect, it, vi } from "vitest";
import { ModelProviderApi, useModel, useStreamOptions } from "@sweatpants/model-provider";
import { pi, createPiAiModelProvider, ModelResolutionError } from "../index.ts";

const customModel: Model<string> = {
  id: "private-model",
  name: "Private model",
  provider: "private-provider",
  api: "openai-responses",
  baseUrl: "https://private.example/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const response: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "custom response" }],
  api: customModel.api,
  provider: customModel.provider,
  model: customModel.id,
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

function completedStream() {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "stop", message: response });
  return stream;
}

describe("configured Pi model provider", () => {
  it("selects a model configuration through the same custom registry", () => {
    const models = createModels();
    models.setProvider(
      createProvider({
        id: customModel.provider,
        models: [customModel],
        auth: {},
        api: { stream: completedStream, streamSimple: completedStream },
      }),
    );
    const configured = pi({
      models,
      provider: customModel.provider,
      model: customModel.id,
      streamOptions: { maxTokens: 123 },
    });
    expect(configured.model).toMatchObject({
      id: customModel.id,
      provider: customModel.provider,
      baseUrl: customModel.baseUrl,
    });
    expect(configured.streamOptions).toEqual({ maxTokens: 123 });
    expect(() => pi({ models, provider: customModel.provider, model: "unknown" })).toThrow(
      ModelResolutionError,
    );
  });

  it("resolves and executes a custom model through one collection, including scoped installation", async () => {
    const stream = vi.fn<ProviderStreams["stream"]>(completedStream);
    const streamSimple = vi.fn<ProviderStreams["streamSimple"]>(completedStream);
    const models = createModels();
    models.setProvider(
      createProvider({
        id: customModel.provider,
        models: [customModel],
        auth: {
          apiKey: {
            name: "Test credentials",
            resolve: async () => ({ auth: { apiKey: "test-key" }, source: "env" }),
          },
        },
        api: { stream, streamSimple },
      }),
    );
    const provider = createPiAiModelProvider({ models });
    const model = provider.resolveModel({ provider: customModel.provider, id: customModel.id });
    expect(model.baseUrl).toBe(customModel.baseUrl);
    await run(function* () {
      yield* provider.install({ model, streamOptions: { maxTokens: 123 } });
      expect(yield* useModel()).toEqual(model);
      const options = yield* useStreamOptions();
      expect(options).toEqual({ maxTokens: 123 });
      const result = yield* ModelProviderApi.operations.sample({
        model,
        context: { messages: [], tools: [] },
        options: options!,
      });
      expect(result.message.content).toEqual([{ type: "text", text: "custom response" }]);
      const subscription = yield* provider.runtime.stream(
        model,
        { messages: [], tools: [] },
        { toolChoice: "none" },
      );
      while (!(yield* subscription.next()).done) {
        /* consume the direct stream */
      }
    });
    expect(streamSimple).toHaveBeenCalledWith(
      expect.objectContaining({ id: customModel.id }),
      expect.anything(),
      expect.objectContaining({ maxTokens: 123, apiKey: "test-key" }),
    );
    expect(stream).toHaveBeenCalledOnce();
  });

  it("preserves reasoning for structured sampling without forcing a tool choice", async () => {
    const stream = vi.fn<ProviderStreams["stream"]>(completedStream);
    const streamSimple = vi.fn<ProviderStreams["streamSimple"]>(completedStream);
    const models = createModels();
    models.setProvider(
      createProvider({
        id: customModel.provider,
        models: [{ ...customModel, reasoning: true }],
        auth: {
          apiKey: {
            name: "Test credentials",
            resolve: async () => ({ auth: { apiKey: "test-key" }, source: "env" }),
          },
        },
        api: { stream, streamSimple },
      }),
    );
    const provider = createPiAiModelProvider({ models });
    const model = provider.resolveModel({ provider: customModel.provider, id: customModel.id });
    await run(function* () {
      const subscription = yield* provider.runtime.stream(
        model,
        { messages: [], tools: [] },
        {
          apiKey: "test-key",
          thinking: "medium",
          responseFormat: { type: "json_schema", schema: { type: "object" } },
        },
      );
      while (true) {
        const next = yield* subscription.next();
        if (next.done) {
          expect(next.value.errorMessage).toBeNull();
          break;
        }
      }
    });
    expect(stream).not.toHaveBeenCalled();
    expect(streamSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Return the final response by calling __schema__"),
            toolsAdded: [expect.objectContaining({ name: "__schema__" })],
          }),
        ],
      }),
      expect.objectContaining({ reasoning: "medium" }),
    );
    expect(streamSimple.mock.calls[0]?.[2]).not.toHaveProperty("toolChoice");
  });

  it("generates images through the configured collection and its credentials", async () => {
    const imageModel: ImageModel<string> = {
      type: "image",
      id: "private-image",
      name: "Private image",
      provider: customModel.provider,
      api: "openai-images",
      baseUrl: customModel.baseUrl,
      input: ["text"],
      output: ["image"],
      cost: customModel.cost,
    };
    const generateImages = vi.fn<ProviderImages["generateImages"]>(async () => ({
      api: imageModel.api,
      provider: imageModel.provider,
      model: imageModel.id,
      output: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      stopReason: "stop",
      timestamp: 1,
    }));
    const models = createModels();
    models.setProvider(
      createProvider({
        id: customModel.provider,
        models: [customModel, imageModel],
        auth: {
          apiKey: {
            name: "Test credentials",
            resolve: async () => ({ auth: { apiKey: "shared-key" }, source: "env" }),
          },
        },
        api: { stream: completedStream, streamSimple: completedStream },
        images: { "openai-images": { generateImages } },
      }),
    );
    const provider = createPiAiModelProvider({ models });
    await run(function* () {
      const result = yield* provider.runtime.generateImages(imageModel, { input: "Draw a tree" });
      expect(result.stopReason).toBe("stop");
      expect(result.output).toEqual([
        {
          type: "image",
          source: { type: "data", value: "aW1hZ2U=", mimeType: "image/png" },
          metadata: null,
        },
      ]);
    });
    expect(generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ id: imageModel.id, type: "image" }),
      { input: [{ type: "text", text: "Draw a tree" }] },
      expect.objectContaining({ apiKey: "shared-key", signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps configured catalogs isolated and reads collection updates without a stale snapshot", () => {
    const models = createModels();
    const provider = createPiAiModelProvider({ models });
    const selection = { provider: customModel.provider, id: customModel.id };
    expect(() => provider.resolveModel(selection)).toThrow(ModelResolutionError);
    expect(() => provider.resolveModel({ provider: "openai", id: "gpt-4o" })).toThrow(
      ModelResolutionError,
    );
    models.setProvider(
      createProvider({
        id: customModel.provider,
        models: [customModel],
        auth: { apiKey: { name: "Test credentials", resolve: async () => undefined } },
        api: { stream: completedStream, streamSimple: completedStream },
      }),
    );
    expect(provider.resolveModel(selection).id).toBe(customModel.id);
    expect(() =>
      createPiAiModelProvider({ models: createModels() }).resolveModel(selection),
    ).toThrow(ModelResolutionError);
    models.deleteProvider(customModel.provider);
    expect(() => provider.resolveModel(selection)).toThrow(ModelResolutionError);
  });
});
