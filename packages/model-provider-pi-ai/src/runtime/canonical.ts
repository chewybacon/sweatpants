import type * as PiAi from "@earendil-works/pi-ai";
import {
  assertJson,
  canonicalJson,
  requireJsonObject,
  type JsonObject,
} from "@sweatpants/foundation";
import {
  decodeChatAssistantMessage,
  decodeChatContent,
  decodeChatToolCall,
  type ChatAssistantMessage,
  type ChatContent,
  type ChatContentPart,
  type ChatMessage,
  type ChatMessagePart,
  type ChatToolCall,
  type ChatToolDefinition,
} from "@sweatpants/chat-contract";
import {
  ModelDecodeError,
  UnsupportedModelCapabilityError,
  decodeModelResponse,
  decodeModelStreamEvent,
  type AssistantImages,
  type ImageGenerationContext,
  type Model,
  type ModelContext,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelUsage,
} from "@sweatpants/model-provider";

/** Reserved only at the Pi-AI structured-output wire boundary. */
export const STRUCTURED_RESPONSE_TOOL_NAME = "__schema__";

function unsupported(path: string, modality: string, message: string): never {
  throw new UnsupportedModelCapabilityError(path, modality, message);
}

/** Maps canonical tool-choice semantics to Pi-AI API-specific wire vocabulary. */
export function encodePiToolChoice(
  model: Model,
  choice: "auto" | "none" | "required",
): "auto" | "none" | "required" | "any" {
  if (choice !== "required") return choice;
  switch (model.api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
    case "google-generative-ai":
    case "google-vertex":
      return "any";
    default:
      return choice;
  }
}

/** Encodes canonical Model context directly into Pi-AI SDK values. */
export function encodePiContext(context: ModelContext, model: Model): PiAi.Context {
  assertSettledToolHistory(context.messages);

  const instructions: string[] = [];
  const messages: PiAi.Message[] = [];
  let encounteredConversationMessage = false;

  for (const [index, message] of context.messages.entries()) {
    const path = `$.messages[${index}]`;
    if (message.role === "system" || message.role === "developer") {
      if (encounteredConversationMessage) {
        unsupported(
          path,
          "instruction-order",
          "Pi-AI only represents system and developer instructions as a leading system prompt",
        );
      }
      instructions.push(message.content);
      continue;
    }

    encounteredConversationMessage = true;
    messages.push(encodePiMessage(message, model, path));
  }

  const output: PiAi.Context = {
    messages,
    ...(instructions.length > 0 ? { systemPrompt: instructions.join("\n\n") } : {}),
  };
  if (context.tools.length > 0) {
    output.tools = context.tools.map((tool, index) =>
      encodePiToolDefinition(tool, `$.tools[${index}]`),
    );
  }
  return output;
}

/** Adds the adapter-owned synthetic structured-output tool to an SDK context. */
export function appendPiStructuredResponseTool(
  context: PiAi.Context,
  schema: JsonObject,
): PiAi.Context {
  return {
    ...context,
    tools: [
      encodePiToolDefinition(
        {
          name: STRUCTURED_RESPONSE_TOOL_NAME,
          description: "Respond with structured data matching this schema.",
          parameters: schema,
        },
        "$.responseFormat.schema",
      ),
      ...(context.tools ?? []),
    ],
  };
}

/** Decodes one Pi-AI SDK terminal response directly into a Model envelope. */
export function decodePiModelResponse(message: PiAi.AssistantMessage): ModelResponse {
  return decodeModelResponse(
    {
      message: decodePiAssistantMessage(message, true, "$.response.message"),
      source: {
        api: message.api,
        provider: message.provider,
        model: message.model,
        responseModel: message.responseModel ?? null,
      },
      usage: modelUsage(message.usage),
      stopReason: message.stopReason,
      responseId: message.responseId ?? null,
      errorMessage: redactProviderError(message.errorMessage) ?? null,
    },
    "$.pi.response",
  );
}

/** Decodes one Pi-AI SDK stream event directly into a Model stream envelope. */
export function decodePiModelStreamEvent(event: PiAi.AssistantMessageEvent): ModelStreamEvent {
  const partial = (message: PiAi.AssistantMessage) =>
    decodePiAssistantMessage(message, false, "$.partial");
  const decoded = (() => {
    switch (event.type) {
      case "start":
        return { type: "start", partial: partial(event.partial) };
      case "text_start":
        return {
          type: "text-start",
          contentIndex: event.contentIndex,
          partial: partial(event.partial),
        };
      case "text_delta":
        return {
          type: "text-delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial: partial(event.partial),
        };
      case "text_end":
        return {
          type: "text-end",
          contentIndex: event.contentIndex,
          content: event.content,
          partial: partial(event.partial),
        };
      case "thinking_start":
        return {
          type: "reasoning-start",
          contentIndex: event.contentIndex,
          partial: partial(event.partial),
        };
      case "thinking_delta":
        return {
          type: "reasoning-delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial: partial(event.partial),
        };
      case "thinking_end":
        return {
          type: "reasoning-end",
          contentIndex: event.contentIndex,
          content: event.content,
          partial: partial(event.partial),
        };
      case "toolcall_start":
        return {
          type: "tool-call-start",
          contentIndex: event.contentIndex,
          partial: partial(event.partial),
        };
      case "toolcall_delta":
        return {
          type: "tool-call-delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial: partial(event.partial),
        };
      case "toolcall_end":
        return {
          type: "tool-call-end",
          contentIndex: event.contentIndex,
          toolCall: decodePiToolCall(event.toolCall, true, "$.toolCall"),
          partial: partial(event.partial),
        };
      case "done":
        return {
          type: "done",
          reason: event.reason,
          message: decodePiAssistantMessage(event.message, true, "$.message"),
        };
      case "error":
        return {
          type: "error",
          reason: event.reason,
          error: decodePiAssistantMessage(event.error, false, "$.error"),
        };
    }
  })();
  return decodeModelStreamEvent(decoded, "$.pi.streamEvent");
}

/** Encodes canonical image-generation input directly into Pi-AI SDK values. */
export function encodePiImageContext(context: ImageGenerationContext): PiAi.ImagesContext {
  const input: PiAi.ImagesContext["input"] =
    typeof context.input === "string"
      ? [{ type: "text", text: context.input }]
      : context.input.map((part, index) => encodePiContentPart(part, `$.input[${index}]`));
  return { input };
}

/** Decodes Pi-AI image output into the canonical Model image envelope. */
export function decodePiImages(images: PiAi.AssistantImages): AssistantImages {
  const output = images.output.map((part, index): ChatContentPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return {
        type: "image",
        source: { type: "data", value: part.data, mimeType: part.mimeType },
        metadata: null,
      };
    }
    return unsupported(
      `$.output[${index}]`,
      "image-output",
      `Pi-AI returned unsupported image output ${JSON.stringify(part)}`,
    );
  });
  const decoded = decodeChatContent(output);
  if (typeof decoded === "string") {
    throw new ModelDecodeError("invalid-response", "$.output", "expected image output parts");
  }
  return {
    output: decoded,
    usage: images.usage === undefined ? null : modelUsage(images.usage),
    stopReason: images.stopReason,
    responseId: images.responseId ?? null,
    errorMessage: redactProviderError(images.errorMessage) ?? null,
    metadata: {
      api: images.api,
      provider: images.provider,
      model: images.model,
      timestamp: images.timestamp,
    },
  };
}

/** Projects the adapter-owned structured-output control call into canonical text. */
export function projectStructuredModelResponse(response: ModelResponse): ModelResponse {
  const projected = projectStructuredAssistantMessage(response.message);
  if (!projected.consumed) return response;
  return {
    ...response,
    message: projected.message,
    stopReason: response.stopReason === "toolUse" ? "stop" : response.stopReason,
  };
}

/** Projects synthetic structured-output calls out of non-terminal Model events. */
export function projectStructuredModelStreamEvent(event: ModelStreamEvent): ModelStreamEvent {
  switch (event.type) {
    case "done": {
      const projected = projectStructuredAssistantMessage(event.message);
      return projected.consumed
        ? {
            ...event,
            message: projected.message,
            reason: event.reason === "toolUse" ? "stop" : event.reason,
          }
        : event;
    }
    case "error": {
      const projected = projectStructuredAssistantMessage(event.error);
      return projected.consumed ? { ...event, error: projected.message } : event;
    }
    default: {
      const projected = projectStructuredAssistantMessage(event.partial);
      return projected.consumed ? { ...event, partial: projected.message } : event;
    }
  }
}

function encodePiMessage(
  message: Exclude<ChatMessage, { role: "system" | "developer" }>,
  model: Model,
  path: string,
): PiAi.Message {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: encodePiContent(message.content, `${path}.content`),
        timestamp: Date.now(),
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content.map((part, index) =>
          encodePiAssistantPart(part, `${path}.content[${index}]`),
        ),
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyPiUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
    case "tool":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: encodePiToolResultContent(message.content, `${path}.content`),
        isError: message.isError,
        timestamp: Date.now(),
      };
  }
}

function encodePiContent(
  content: ChatContent,
  path: string,
): string | Array<PiAi.TextContent | PiAi.ImageContent> {
  if (typeof content === "string") return content;
  return content.map((part, index) => encodePiContentPart(part, `${path}[${index}]`));
}

function encodePiToolResultContent(
  content: ChatContent,
  path: string,
): Array<PiAi.TextContent | PiAi.ImageContent> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part, index) => encodePiContentPart(part, `${path}[${index}]`));
}

function encodePiContentPart(
  part: ChatContentPart,
  path: string,
): PiAi.TextContent | PiAi.ImageContent {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type !== "image") {
    return unsupported(path, part.type, `Pi-AI does not support ${part.type} content`);
  }
  if (part.source.type !== "data") {
    return unsupported(path, "image-url", "Pi-AI requires inline image data");
  }
  if (part.metadata !== null) {
    return unsupported(path, "image-metadata", "Pi-AI cannot represent image metadata");
  }
  return { type: "image", data: part.source.value, mimeType: part.source.mimeType };
}

function encodePiAssistantPart(
  part: ChatMessagePart,
  path: string,
): PiAi.TextContent | PiAi.ThinkingContent | PiAi.ToolCall {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
    case "audio":
    case "video":
    case "document":
      return unsupported(
        path,
        `assistant-${part.type}`,
        `Pi-AI cannot represent assistant ${part.type} parts`,
      );
    case "reasoning":
      if (part.format !== null) {
        return unsupported(path, "reasoning-format", "Pi-AI cannot represent reasoning format");
      }
      return {
        type: "thinking",
        thinking: part.text,
        ...(part.signature !== null ? { thinkingSignature: part.signature } : {}),
        ...(part.redacted ? { redacted: true } : {}),
      };
    case "tool-call":
      return encodePiToolCall(part.toolCall, `${path}.toolCall`);
  }
}

function encodePiToolCall(call: ChatToolCall, path: string): PiAi.ToolCall {
  if (!isJsonObject(call.input)) {
    return unsupported(
      `${path}.input`,
      "tool-call-input",
      "Pi-AI requires a JSON object for tool-call input",
    );
  }
  return {
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.input,
    ...(call.thoughtSignature !== null ? { thoughtSignature: call.thoughtSignature } : {}),
  };
}

function encodePiToolDefinition(
  definition: ChatToolDefinition,
  _path: string,
): NonNullable<PiAi.Context["tools"]>[number] {
  // Pi-AI describes tool schemas as TypeBox values, while its runtime sends the
  // canonical JSON Schema object unchanged. `ChatToolDefinition.parameters` is
  // owner-decoded JSON at this boundary; no semantic conversion occurs here.
  return {
    name: definition.name,
    description: definition.description ?? "",
    parameters: definition.parameters,
  };
}

function decodePiAssistantMessage(
  message: PiAi.AssistantMessage,
  settled: boolean,
  path: string,
): ChatAssistantMessage {
  const content: ChatMessagePart[] = [];
  for (const [index, part] of message.content.entries()) {
    const decoded = decodePiAssistantPart(part, settled, `${path}.content[${index}]`);
    if (decoded !== null) content.push(decoded);
  }
  try {
    return decodeChatAssistantMessage({ role: "assistant", content }, path);
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-response",
      path,
      error instanceof Error ? error.message : "Pi-AI assistant message is invalid",
    );
  }
}

function decodePiAssistantPart(
  part: PiAi.AssistantMessage["content"][number],
  settled: boolean,
  path: string,
): ChatMessagePart | null {
  switch (part.type) {
    case "text":
      // Pi-AI text signatures are provider response bookkeeping rather than a
      // canonical replay field. The adapter intentionally does not surface it.
      return { type: "text", text: part.text };
    case "thinking":
      return {
        type: "reasoning",
        text: part.thinking,
        format: null,
        signature: part.thinkingSignature ?? null,
        redacted: part.redacted ?? false,
      };
    case "toolCall":
      if (!settled && (part.id.length === 0 || part.name.length === 0)) {
        // Pi-AI exposes incomplete tool-call fragments during deltas. They are
        // not canonical calls and are represented by the stream event itself;
        // the settled `toolcall_end` event carries the canonical call.
        return null;
      }
      return { type: "tool-call", toolCall: decodePiToolCall(part, settled, path) };
  }
}

function decodePiToolCall(call: PiAi.ToolCall, settled: boolean, path: string): ChatToolCall {
  if (settled && (call.id.length === 0 || call.name.length === 0)) {
    throw new ModelDecodeError(
      "invalid-response",
      path,
      "Pi-AI returned a settled tool call without an id or name",
    );
  }
  try {
    return decodeChatToolCall(
      {
        id: call.id,
        name: call.name,
        input: assertJson(call.arguments, `${path}.arguments`),
        thoughtSignature: call.thoughtSignature ?? null,
      },
      path,
    );
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-response",
      path,
      error instanceof Error ? error.message : "Pi-AI tool call is invalid",
    );
  }
}

function modelUsage(usage: PiAi.Usage): ModelUsage {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function emptyPiUsage(): PiAi.Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assertSettledToolHistory(messages: readonly ChatMessage[]): void {
  const unsettled = new Map<string, { readonly name: string; readonly path: string }>();
  const seen = new Set<string>();

  for (const [messageIndex, message] of messages.entries()) {
    const path = `$.messages[${messageIndex}]`;
    if (message.role === "assistant") {
      for (const [partIndex, part] of message.content.entries()) {
        if (part.type !== "tool-call") continue;
        const callPath = `${path}.content[${partIndex}].toolCall`;
        if (seen.has(part.toolCall.id)) {
          unsupported(
            callPath,
            "duplicate-tool-call",
            "Pi-AI requires unique tool-call ids in history",
          );
        }
        seen.add(part.toolCall.id);
        unsettled.set(part.toolCall.id, { name: part.toolCall.name, path: callPath });
      }
      continue;
    }
    if (message.role !== "tool") continue;

    const call = unsettled.get(message.toolCallId);
    if (call === undefined) {
      unsupported(
        `${path}.toolCallId`,
        "orphan-tool-result",
        "Pi-AI cannot encode a tool result without a preceding unsettled tool call",
      );
    }
    if (call.name !== message.name) {
      unsupported(
        `${path}.name`,
        "tool-result-name",
        `tool result name ${JSON.stringify(message.name)} does not match ${JSON.stringify(call.name)}`,
      );
    }
    unsettled.delete(message.toolCallId);
  }

  const first = unsettled.values().next().value as
    | { readonly name: string; readonly path: string }
    | undefined;
  if (first !== undefined) {
    unsupported(
      first.path,
      "unsettled-tool-call",
      `Pi-AI cannot encode historical tool call ${JSON.stringify(first.name)} without its result`,
    );
  }
}

function projectStructuredAssistantMessage(message: ChatAssistantMessage): {
  readonly message: ChatAssistantMessage;
  readonly consumed: boolean;
} {
  let consumed = false;
  const content: ChatMessagePart[] = [];
  for (const part of message.content) {
    if (part.type === "tool-call" && part.toolCall.name === STRUCTURED_RESPONSE_TOOL_NAME) {
      consumed = true;
      content.push({ type: "text", text: canonicalJson(part.toolCall.input) });
      continue;
    }
    content.push(part);
  }
  if (!consumed) return { message, consumed };
  try {
    return {
      message: decodeChatAssistantMessage({ role: "assistant", content }, "$.structuredResponse"),
      consumed,
    };
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-response",
      "$.structuredResponse",
      error instanceof Error ? error.message : "structured response projection is invalid",
    );
  }
}

function redactProviderError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]")
    .replace(/arn:aws:[^\s"']+/g, "[redacted-aws-arn]")
    .replace(/\b\d{12}\b/g, "[redacted-account-id]")
    .slice(0, 2000);
}

function isJsonObject(value: unknown): value is JsonObject {
  try {
    requireJsonObject(assertJson(value), "$.input");
    return true;
  } catch {
    return false;
  }
}
