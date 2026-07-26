import { call, resource, useAbortSignal, type Operation } from "effection";
import {
  generateImages as piGenerateImages,
  streamSimple as piStreamSimple,
} from "@earendil-works/pi-ai/compat";
import { toProviderJsonSchema } from "./schema-normalization.ts";
import type {
  AssistantImages as PiAssistantImages,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent as PiAssistantMessageEvent,
  Context as PiContext,
  ImagesContext as PiImagesContext,
  ImagesModel as PiImagesModel,
  Model as PiModel,
  ProviderImagesOptions as PiProviderImagesOptions,
  SimpleStreamOptions as PiSimpleStreamOptions,
  ToolCall as PiToolCall,
  Usage as PiUsage,
} from "@earendil-works/pi-ai/compat";
import type {
  AssistantImages,
  AssistantMessage,
  ContentBlock,
  Context,
  ImageGenerationContext,
  ImageGenerationOptions,
  ImageModel,
  Model,
  Message,
  Runtime,
  StreamEvent,
  StreamOptions,
  ThinkingLevel,
  ToolCallBlock,
  Usage,
} from "./types.ts";

const SCHEMA_TOOL_NAME = "__schema__";

interface CombinedAbortController {
  controller: AbortController;
  cleanup(): void;
}

function combineAbortSignals(
  scopeSignal: AbortSignal,
  callerSignal?: AbortSignal,
): CombinedAbortController {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  scopeSignal.addEventListener("abort", abort, { once: true });
  callerSignal?.addEventListener("abort", abort, { once: true });

  if (scopeSignal.aborted || callerSignal?.aborted) {
    abort();
  }

  return {
    controller,
    cleanup() {
      scopeSignal.removeEventListener("abort", abort);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}

function toPiUsage(usage: Usage | undefined): PiUsage {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.total ?? (usage?.input ?? 0) + (usage?.output ?? 0),
    cost: {
      input: usage?.cost?.input ?? 0,
      output: usage?.cost?.output ?? 0,
      cacheRead: usage?.cost?.cacheRead ?? 0,
      cacheWrite: usage?.cost?.cacheWrite ?? 0,
      total: usage?.cost?.total ?? 0,
    },
  };
}

function fromPiUsage(usage: PiUsage | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
  };
}

function toPiContentBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case "thinking":
      return {
        type: "thinking",
        thinking: block.text,
        ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
        ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
      };
    case "toolCall":
      return {
        ...block,
        arguments: normalizeToolArguments(block.arguments),
      };
    default:
      return block;
  }
}

function fromPiContentBlock(block: unknown): ContentBlock {
  const candidate = block as { type?: unknown; [key: string]: unknown };

  if (candidate.type === "thinking") {
    return {
      type: "thinking",
      text: typeof candidate["thinking"] === "string" ? candidate["thinking"] : "",
      ...(typeof candidate["format"] === "string" ? { format: candidate["format"] } : {}),
      ...(typeof candidate["thinkingSignature"] === "string"
        ? { thinkingSignature: candidate["thinkingSignature"] }
        : {}),
      ...(typeof candidate["redacted"] === "boolean" ? { redacted: candidate["redacted"] } : {}),
    };
  }

  if (candidate.type === "text") {
    return {
      type: "text",
      text: typeof candidate["text"] === "string" ? candidate["text"] : "",
      ...(typeof candidate["textSignature"] === "string"
        ? { textSignature: candidate["textSignature"] }
        : {}),
    };
  }

  if (candidate.type === "image") {
    return {
      type: "image",
      data: typeof candidate["data"] === "string" ? candidate["data"] : "",
      mimeType:
        typeof candidate["mimeType"] === "string"
          ? candidate["mimeType"]
          : "application/octet-stream",
    };
  }

  if (candidate.type === "toolCall") {
    return {
      type: "toolCall",
      id: typeof candidate["id"] === "string" ? candidate["id"] : "",
      name: typeof candidate["name"] === "string" ? candidate["name"] : "",
      arguments: normalizeToolArguments(candidate["arguments"]),
      ...(typeof candidate["thoughtSignature"] === "string"
        ? { thoughtSignature: candidate["thoughtSignature"] }
        : {}),
    };
  }

  return { type: "text", text: "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBlockHasProviderPayload(block: ContentBlock): boolean {
  if (block.type === "text" || block.type === "thinking") {
    return block.text.trim().length > 0;
  }
  if (block.type === "image") {
    return block.data.length > 0;
  }
  if (block.type === "toolCall") {
    return block.name.trim().length > 0;
  }
  return false;
}

function providerMessageHasPayload(message: Message): boolean {
  if (message.role === "assistant") {
    return message.content.some(contentBlockHasProviderPayload);
  }
  if (message.role === "toolResult") {
    return message.content.some(contentBlockHasProviderPayload);
  }
  return true;
}

/**
 * Provider-boundary safety normalization.
 *
 * Completed historical tool call/result pairs are semantic causal records and
 * are preserved exactly as projected by the client session (REQ-038). The
 * boundary only repairs wire-invalid shapes it cannot send:
 *
 * - a hanging assistant toolCall with no result anywhere after it (the
 *   Responses API rejects a function_call without a function_call_output), and
 * - an orphan toolResult whose call id never appears in an earlier assistant
 *   message (un-referencable on the wire).
 *
 * Both repairs drop only the unresolvable side. History compaction is
 * deliberately NOT performed here; that is client/application policy.
 */
function normalizeProviderMessages(messages: Message[]): Message[] {
  const filtered = messages.filter(providerMessageHasPayload);

  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of filtered) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && contentBlockHasProviderPayload(block)) {
          callIds.add(block.id);
        }
      }
    }
    if (message.role === "toolResult") {
      resultIds.add(message.toolCallId);
    }
  }

  const normalized: Message[] = [];
  for (const message of filtered) {
    if (message.role === "toolResult") {
      if (!callIds.has(message.toolCallId)) {
        continue; // orphan result: no referencable call
      }
      normalized.push(message);
      continue;
    }
    if (message.role !== "assistant") {
      normalized.push(message);
      continue;
    }
    const content = message.content.filter(
      (block) => block.type !== "toolCall" || resultIds.has(block.id),
    );
    if (content.length === message.content.length) {
      normalized.push(message);
      continue;
    }
    if (content.some(contentBlockHasProviderPayload)) {
      normalized.push({ ...message, content });
    }
    // An assistant message consisting solely of hanging tool calls is dropped:
    // nothing wire-valid remains.
  }
  return normalized;
}

function safeErrorMessage(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]")
    .replace(/arn:aws:[^\s"']+/g, "[redacted-aws-arn]")
    .replace(/\b\d{12}\b/g, "[redacted-account-id]")
    .slice(0, 2000);
}

function safeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "raw" || key === "diagnostics" || key === "stack" || key === "details") {
      continue;
    }
    result[key] = typeof value === "string" ? safeErrorMessage(value) : value;
  }
  return result;
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function fromPiToolCall(toolCall: PiToolCall): ToolCallBlock {
  return {
    type: "toolCall",
    id: toolCall.id,
    name: toolCall.name,
    arguments: normalizeToolArguments(toolCall.arguments),
    ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
  };
}

function toPiAssistantMessage(message: AssistantMessage): PiAssistantMessage {
  const errorMessage = safeErrorMessage(message.errorMessage);
  return {
    role: "assistant",
    content: message.content
      .filter((block) => block.type !== "image")
      .map(toPiContentBlock) as PiAssistantMessage["content"],
    api: String(message.metadata?.["api"] ?? ""),
    provider: String(message.metadata?.["provider"] ?? ""),
    model: String(message.metadata?.["model"] ?? ""),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    usage: toPiUsage(message.usage),
    stopReason: (message.stopReason ?? "stop") as PiAssistantMessage["stopReason"],
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: message.timestamp ?? Date.now(),
  };
}

function fromPiAssistantMessage(message: PiAssistantMessage): AssistantMessage {
  const usage = fromPiUsage(message.usage);
  const errorMessage = safeErrorMessage(message.errorMessage);
  return {
    role: "assistant",
    content: message.content.map(fromPiContentBlock),
    ...(usage ? { usage } : {}),
    stopReason: message.stopReason,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: message.timestamp,
    metadata: safeMetadata({
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    }),
  };
}

function unwrapSchemaResponseMessage(message: AssistantMessage): AssistantMessage {
  let consumedSchemaTool = false;
  const content: ContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === "toolCall" && block.name === SCHEMA_TOOL_NAME) {
      consumedSchemaTool = true;
      content.push({ type: "text", text: JSON.stringify(block.arguments) });
      continue;
    }
    content.push(block);
  }

  if (!consumedSchemaTool) {
    return message;
  }
  const { stopReason: currentStopReason, ...rest } = message;
  const stopReason = currentStopReason === "toolUse" ? "stop" : currentStopReason;
  return {
    ...rest,
    content,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function fromPiAssistantMessageForOptions(
  message: PiAssistantMessage,
  options: StreamOptions | undefined,
): AssistantMessage {
  const assistant = fromPiAssistantMessage(message);
  return options?.responseFormat ? unwrapSchemaResponseMessage(assistant) : assistant;
}

function toPiContext(context: Context): PiContext {
  const messages: PiContext["messages"] = [];
  const systemMessages = context.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);

  for (const message of normalizeProviderMessages(context.messages)) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: Array.isArray(message.content)
          ? (message.content
              .filter((block) => block.type === "text" || block.type === "image")
              .map(toPiContentBlock) as Array<
              { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
            >)
          : message.content,
        timestamp: message.timestamp ?? Date.now(),
      });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content.some(contentBlockHasProviderPayload)) {
        messages.push(toPiAssistantMessage(message));
      }
      continue;
    }

    const toolResultContent = message.content
      .filter(
        (block) =>
          (block.type === "text" || block.type === "image") &&
          contentBlockHasProviderPayload(block),
      )
      .map(toPiContentBlock) as Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    >;

    if (toolResultContent.length === 0) {
      continue;
    }

    messages.push({
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: toolResultContent,
      isError: message.isError,
      timestamp: message.timestamp ?? Date.now(),
    });
  }

  const systemPrompt = [context.systemPrompt, ...systemMessages].filter(Boolean).join("\n\n");
  const piContext: PiContext = {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages,
  };
  if (context.tools) {
    piContext.tools = context.tools.map((tool) => ({
      ...tool,
      parameters: toProviderJsonSchema(tool.parameters),
    })) as NonNullable<PiContext["tools"]>;
  }
  return piContext;
}

function toPiModel(model: Model): PiModel<string> {
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

function toPiImageModel(model: ImageModel): PiImagesModel<string> {
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
  context: Context,
  options: StreamOptions | undefined,
): void {
  if (!options?.responseFormat || !context.tools?.length) {
    return;
  }
  if (context.tools.some((tool) => tool.name === SCHEMA_TOOL_NAME)) {
    throw new Error(`Tool name "${SCHEMA_TOOL_NAME}" is reserved for structured response output`);
  }
  throw new Error(
    "responseFormat cannot be combined with application tools in a single provider request",
  );
}

function toPiContextWithResponseFormat(
  context: Context,
  options: StreamOptions | undefined,
): PiContext {
  const piContext = toPiContext(context);
  if (!options?.responseFormat) {
    return piContext;
  }

  const schemaTool = {
    name: SCHEMA_TOOL_NAME,
    description: "Respond with structured data matching this schema.",
    parameters: toProviderJsonSchema(options.responseFormat.schema),
  };

  return {
    ...piContext,
    tools: [schemaTool, ...(piContext.tools ?? [])] as NonNullable<PiContext["tools"]>,
  };
}

function toPiStreamOptions(
  model: Model,
  options: StreamOptions | undefined,
  signal: AbortSignal,
): PiSimpleStreamOptions & Record<string, unknown> {
  const apiKey = options?.apiKey ?? (model.provider === "ollama" ? "ollama" : undefined);
  const reasoning = toPiReasoning(options);
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
    ...(options?.responseFormat
      ? { toolChoice: "required" }
      : options?.toolChoice
        ? { toolChoice: options.toolChoice }
        : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(options?.thinkingBudgets ? { thinkingBudgets: options.thinkingBudgets } : {}),
  };
}

function toPiImageOptions(
  options: ImageGenerationOptions | undefined,
  signal: AbortSignal,
): PiProviderImagesOptions {
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

function fromPiEvent(event: PiAssistantMessageEvent): StreamEvent {
  switch (event.type) {
    case "toolcall_end":
      return {
        type: "toolcall_end",
        contentIndex: event.contentIndex,
        toolCall: fromPiToolCall(event.toolCall),
        partial: fromPiAssistantMessage(event.partial),
      };
    case "done":
      return {
        type: "done",
        reason: event.reason,
        message: fromPiAssistantMessage(event.message),
      };
    case "error":
      return {
        type: "error",
        reason: event.reason,
        error: fromPiAssistantMessage(event.error),
      };
    case "text_end":
    case "thinking_end":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        content: event.content,
        partial: fromPiAssistantMessage(event.partial),
      };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        delta: event.delta,
        partial: fromPiAssistantMessage(event.partial),
      };
    case "start":
      return {
        type: "start",
        partial: fromPiAssistantMessage(event.partial),
      };
    default:
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        partial: fromPiAssistantMessage(event.partial),
      };
  }
}

function unwrapSchemaResponseEvent(event: StreamEvent): StreamEvent {
  switch (event.type) {
    case "done": {
      const message = unwrapSchemaResponseMessage(event.message);
      return { ...event, reason: message.stopReason ?? event.reason, message };
    }
    case "error":
      return { ...event, error: unwrapSchemaResponseMessage(event.error) };
    case "start":
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return { ...event, partial: unwrapSchemaResponseMessage(event.partial) };
  }
}

function fromPiEventForOptions(
  event: PiAssistantMessageEvent,
  options: StreamOptions | undefined,
): StreamEvent | undefined {
  if (options?.responseFormat && event.type.startsWith("toolcall_")) {
    return undefined;
  }
  const converted = fromPiEvent(event);
  return options?.responseFormat ? unwrapSchemaResponseEvent(converted) : converted;
}

function toPiImagesContext(context: ImageGenerationContext): PiImagesContext {
  return {
    input: context.input.map(toPiContentBlock) as PiImagesContext["input"],
  };
}

function fromPiAssistantImages(images: PiAssistantImages): AssistantImages {
  const usage = fromPiUsage(images.usage);
  const errorMessage = safeErrorMessage(images.errorMessage);
  return {
    output: images.output.map(fromPiContentBlock) as AssistantImages["output"],
    ...(usage ? { usage } : {}),
    stopReason: images.stopReason,
    ...(images.responseId ? { responseId: images.responseId } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    metadata: {
      api: images.api,
      provider: images.provider,
      model: images.model,
      timestamp: images.timestamp,
    },
  };
}

export function createPiAiRuntime(): Runtime {
  return {
    stream(model, context, options) {
      return resource(function* (provide) {
        assertResponseFormatToolPolicy(context, options);
        const scopeSignal = yield* useAbortSignal();
        const combined = combineAbortSignals(scopeSignal, options?.signal);
        const stream = piStreamSimple(
          toPiModel(model),
          toPiContextWithResponseFormat(context, options),
          toPiStreamOptions(model, options, combined.controller.signal),
        );
        const iterator = stream[Symbol.asyncIterator]();

        try {
          yield* provide({
            *next(): Operation<IteratorResult<StreamEvent, AssistantMessage>> {
              while (true) {
                const next = yield* call(() => iterator.next());
                if (!next.done) {
                  const event = fromPiEventForOptions(next.value, options);
                  if (event) {
                    return { done: false, value: event };
                  }
                  continue;
                }
                const finalMessage = yield* call(() => stream.result());
                return {
                  done: true,
                  value: fromPiAssistantMessageForOptions(finalMessage, options),
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

    generateImages(model, context, options) {
      return resource(function* (provide) {
        const scopeSignal = yield* useAbortSignal();
        const combined = combineAbortSignals(scopeSignal, options?.signal);
        try {
          const result = yield* call(() =>
            piGenerateImages(
              toPiImageModel(model),
              toPiImagesContext(context),
              toPiImageOptions(options, combined.controller.signal),
            ),
          );
          yield* provide(fromPiAssistantImages(result));
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
