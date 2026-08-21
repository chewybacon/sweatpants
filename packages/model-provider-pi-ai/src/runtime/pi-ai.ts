import { call, resource, useAbortSignal, type Operation } from "effection";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinImagesModels, builtinModels } from "@earendil-works/pi-ai/providers/all";
import type * as PiAi from "@earendil-works/pi-ai";
import {
  UnsupportedModelCapabilityError,
  type ImageGenerationOptions,
  type ImageModel,
  type Model,
  type ModelContext,
  type ModelResponse,
  type ModelStreamEvent,
  type Runtime,
  type StreamOptions,
  type ThinkingLevel,
} from "@sweatpants/model-provider";
import {
  STRUCTURED_RESPONSE_TOOL_NAME,
  appendPiStructuredResponseTool,
  decodePiImages,
  decodePiModelResponse,
  decodePiModelStreamEvent,
  encodePiContext,
  encodePiToolChoice,
  encodePiImageContext,
  projectStructuredModelResponse,
  projectStructuredModelStreamEvent,
} from "./canonical.ts";

interface CombinedAbortController {
  readonly controller: AbortController;
  cleanup(): void;
}

function combineAbortSignals(
  scopeSignal: AbortSignal,
  callerSignal?: AbortSignal,
): CombinedAbortController {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  scopeSignal.addEventListener("abort", abort, { once: true });
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (scopeSignal.aborted || callerSignal?.aborted) abort();

  return {
    controller,
    cleanup() {
      scopeSignal.removeEventListener("abort", abort);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}

function toPiModel(model: Model): PiAi.Model<string> {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl ?? "",
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input.filter(
      (input): input is "text" | "image" => input === "text" || input === "image",
    ),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(model.headers ? { headers: model.headers } : {}),
    ...(model.compat ? { compat: model.compat as never } : {}),
  };
}

function toPiImageModel(model: ImageModel): PiAi.ImagesModel<string> {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl ?? "",
    input: model.input.filter(
      (input): input is "text" | "image" => input === "text" || input === "image",
    ),
    output: model.output.filter(
      (output): output is "text" | "image" => output === "text" || output === "image",
    ),
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(model.headers ? { headers: model.headers } : {}),
  };
}

function toPiReasoning(options: StreamOptions | undefined): ThinkingLevel | undefined {
  const setting = options?.thinking;
  return setting === "off" ? undefined : setting;
}

function assertResponseFormatToolPolicy(
  context: ModelContext,
  options: StreamOptions | undefined,
): void {
  if (!options?.responseFormat || context.tools.length === 0) return;
  if (context.tools.some((tool) => tool.name === STRUCTURED_RESPONSE_TOOL_NAME)) {
    throw new Error(
      `Tool name "${STRUCTURED_RESPONSE_TOOL_NAME}" is reserved for structured response output`,
    );
  }
  throw new Error(
    "responseFormat cannot be combined with application tools in a single provider request",
  );
}

function toPiContextWithResponseFormat(
  context: ModelContext,
  model: Model,
  options: StreamOptions | undefined,
): PiAi.Context {
  const piContext = encodePiContext(context, model);
  return options?.responseFormat === undefined
    ? piContext
    : appendPiStructuredResponseTool(piContext, options.responseFormat.schema);
}

function usesDirectPiStream(options: StreamOptions | undefined): boolean {
  return options?.toolChoice !== undefined || options?.responseFormat !== undefined;
}

function assertDirectPiStreamCapabilities(model: Model, options: StreamOptions | undefined): void {
  if (
    !usesDirectPiStream(options) ||
    options?.thinking === undefined ||
    options.thinking === "off"
  ) {
    return;
  }
  switch (model.api) {
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
    case "bedrock-converse-stream":
    case "pi-messages":
      return;
    default:
      throw new UnsupportedModelCapabilityError(
        "$.options.thinking",
        "thinking-with-tool-choice",
        `Pi-AI ${model.api} cannot combine canonical thinking with an explicit tool choice`,
        model.provider,
        model.id,
      );
  }
}

function toPiStreamOptions(
  model: Model,
  options: StreamOptions | undefined,
  signal: AbortSignal,
  direct: boolean,
): PiAi.SimpleStreamOptions & Record<string, unknown> {
  const apiKey = options?.apiKey ?? (model.provider === "ollama" ? "ollama" : undefined);
  const reasoning = toPiReasoning(options);
  const toolChoice = options?.responseFormat
    ? encodePiToolChoice(model, "required")
    : options?.toolChoice === undefined
      ? undefined
      : encodePiToolChoice(model, options.toolChoice);
  const reasoningEffort =
    direct &&
    reasoning !== undefined &&
    (model.api === "openai-completions" ||
      model.api === "openai-responses" ||
      model.api === "openai-codex-responses" ||
      model.api === "azure-openai-responses")
      ? reasoning
      : undefined;
  return {
    ...options?.providerOptions,
    signal,
    ...(apiKey ? { apiKey } : {}),
    ...(options?.env ? { env: options.env as Record<string, string> } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.topP !== undefined ? { topP: options.topP } : {}),
    ...(options?.topK !== undefined ? { topK: options.topK } : {}),
    ...(options?.onPayload
      ? { onPayload: (payload: unknown) => options.onPayload?.(payload) }
      : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(options?.thinkingBudgets ? { thinkingBudgets: options.thinkingBudgets } : {}),
  };
}

function toPiImageOptions(
  options: ImageGenerationOptions | undefined,
  signal: AbortSignal,
): PiAi.ImagesOptions & Record<string, unknown> {
  return {
    ...options?.providerOptions,
    signal,
    ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
    ...(options?.onPayload
      ? { onPayload: (payload: unknown) => options.onPayload?.(payload) }
      : {}),
    ...(options?.onResponse
      ? { onResponse: (response: unknown) => options.onResponse?.(response) }
      : {}),
  };
}

function decodeStreamEvent(
  event: PiAi.AssistantMessageEvent,
  options: StreamOptions | undefined,
): ModelStreamEvent | undefined {
  if (options?.responseFormat && event.type.startsWith("toolcall_")) {
    // The synthetic schema call is represented by the terminal canonical text
    // response rather than by ordinary application tool lifecycle events.
    return undefined;
  }
  const decoded = decodePiModelStreamEvent(event);
  return options?.responseFormat ? projectStructuredModelStreamEvent(decoded) : decoded;
}

export interface AdapterRuntimeOptions {
  /** Non-compat Pi-AI model collection; injection keeps provider ownership explicit. */
  readonly models?: PiAi.Models;
  /** Non-compat Pi-AI image-model collection. */
  readonly images?: PiAi.ImagesModels;
}

function createDefaultPiModels(): PiAi.Models {
  const models = builtinModels();
  // Ollama is an app-local, dynamically selected model rather than a model in
  // pi-ai's built-in catalog. Register its OpenAI-compatible transport so the
  // Models collection can still apply auth before dispatching the request.
  models.setProvider(
    createProvider({
      id: "ollama",
      name: "Ollama",
      auth: {
        apiKey: {
          name: "Ollama",
          resolve: async ({ credential, signal }) => {
            signal.throwIfAborted();
            return {
              auth: { apiKey: credential?.key ?? "ollama" },
              source: "local Ollama",
            };
          },
        },
      },
      models: [],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}

const defaultPiModels = createDefaultPiModels();
const defaultPiImages = builtinImagesModels();

export function createPiAiRuntime(options: AdapterRuntimeOptions = {}): Runtime {
  const models = options.models ?? defaultPiModels;
  const images = options.images ?? defaultPiImages;
  return {
    stream(model, context, streamOptions) {
      return resource(function* (provide) {
        assertResponseFormatToolPolicy(context, streamOptions);
        assertDirectPiStreamCapabilities(model, streamOptions);
        const scopeSignal = yield* useAbortSignal();
        const combined = combineAbortSignals(scopeSignal, streamOptions?.signal);
        const piModel = toPiModel(model);
        const piContext = toPiContextWithResponseFormat(context, model, streamOptions);
        const direct = usesDirectPiStream(streamOptions);
        const piOptions = toPiStreamOptions(
          model,
          streamOptions,
          combined.controller.signal,
          direct,
        );
        const stream = direct
          ? models.stream(piModel, piContext, piOptions)
          : models.streamSimple(piModel, piContext, piOptions);
        const iterator = stream[Symbol.asyncIterator]();

        try {
          yield* provide({
            *next(): Operation<IteratorResult<ModelStreamEvent, ModelResponse>> {
              while (true) {
                const next = yield* call(() => iterator.next());
                if (!next.done) {
                  const event = decodeStreamEvent(next.value, streamOptions);
                  if (event !== undefined) return { done: false, value: event };
                  continue;
                }
                const response = decodePiModelResponse(yield* call(() => stream.result()));
                return {
                  done: true,
                  value: streamOptions?.responseFormat
                    ? projectStructuredModelResponse(response)
                    : response,
                };
              }
            },
          });
        } finally {
          combined.controller.abort();
          combined.cleanup();
          if (typeof iterator.return === "function") {
            yield* call(() => iterator.return!(undefined));
          }
        }
      });
    },

    generateImages(model, context, imageOptions) {
      return resource(function* (provide) {
        const scopeSignal = yield* useAbortSignal();
        const combined = combineAbortSignals(scopeSignal, imageOptions?.signal);
        try {
          const result = yield* call(() =>
            images.generateImages(
              toPiImageModel(model),
              encodePiImageContext(context),
              toPiImageOptions(imageOptions, combined.controller.signal),
            ),
          );
          yield* provide(decodePiImages(result));
        } finally {
          combined.controller.abort();
          combined.cleanup();
        }
      });
    },
  };
}

export const piAiRuntime = createPiAiRuntime();

export function createOllamaModel(modelId: string, baseUrl = "http://localhost:11434/v1"): Model {
  return {
    id: modelId,
    name: `${modelId} (Ollama)`,
    api: "openai-completions",
    provider: "ollama",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: false,
    },
  };
}

export function createOpenAiResponsesModel(
  modelId: string,
  baseUrl = "https://api.openai.com/v1",
): Model {
  return {
    id: modelId,
    name: modelId,
    api: "openai-responses",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}
