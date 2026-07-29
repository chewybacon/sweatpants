/**
 * Test Utilities for Durable Chat Handler
 *
 * Provides:
 * - Mock model provider that simulates LLM responses
 * - Test request setup helpers
 * - Response consumption helpers
 * - DI setup helpers
 */
import {
  createScope,
  resource,
  sleep,
  suspend,
  useScope,
  type Operation,
  type Stream,
} from "effection";
import { z } from "zod";
import { createTool, type ToolDefinition as CoreToolDefinition } from "@sweatpants/agent-sdk";
import { createCapabilityKeyring } from "@sweatpants/session-contract";
import type {
  ChatEvent,
  ChatResult,
  Message,
  ToolCall as ProviderToolCall,
} from "../../../lib/chat/types.ts";
import {
  ToolInventoryContext,
  createToolInventory,
  type ToolInventoryEntry,
} from "../../../lib/chat/tool-inventory.ts";
import {
  installToolRuntime,
  createToolExecutionRef,
  type ToolRuntime,
} from "../../../lib/chat/tool-runtime.ts";
import { validateToolParameters } from "../../../lib/chat/tool-parameters.ts";
import {
  installModelProvider,
  ModelProviderModelContext,
  type ModelProviderDriver,
} from "@sweatpants/chat-core";
import type {
  AssistantMessage,
  Model,
  Runtime,
  RuntimeStreamEvent,
  Usage,
} from "@sweatpants/chat-core";
import {
  setupInMemoryDurableStreams,
  type DurableStreamsSetup,
} from "@sweatpants/durable-chat-runtime/response-streams";
import { createDurableChatHandler } from "../handler.ts";
import { createHostScopeOwner, installHostScopeOwner } from "../../../lib/effection/host-scope.ts";
import { installDurableStreamsOwner } from "@sweatpants/durable-chat-runtime/response-streams";
import { createInMemoryProgramDriverJournalStore } from "../program-driver-journal.ts";
import type { ChatHandlerSetup, DurableChatHandlerConfig, DurableStreamEvent } from "../types.ts";
import type { StreamEvent } from "@sweatpants/durable-chat-runtime/handler/types";

/** Test-only handler composition with an isolated in-memory ProgramRuntime journal. */
export function createTestDurableChatHandler(
  config: Omit<DurableChatHandlerConfig, "programDriverJournalStore"> &
    Partial<Pick<DurableChatHandlerConfig, "programDriverJournalStore">>,
): ReturnType<typeof createDurableChatHandler> {
  const handler = createDurableChatHandler({
    ...config,
    programDriverJournalStore:
      config.programDriverJournalStore ??
      createInMemoryProgramDriverJournalStore({
        keyring: createCapabilityKeyring("framework-test-program-runtime", [
          { keyId: "test-v1", secret: "framework-test-program-runtime-secret" },
        ]),
      }),
  });
  const [hostScope] = createScope();
  const hostOwner = createHostScopeOwner(hostScope);
  let resolveInstalled!: () => void;
  const installed = new Promise<void>((resolve) => {
    resolveInstalled = resolve;
  });
  let scoped: ((request: Request) => Promise<Response>) | undefined;
  void hostScope.run(function* () {
    yield* installHostScopeOwner(hostOwner);
    yield* installDurableStreamsOwner(hostOwner);
    const compositionScope = yield* useScope();
    hostOwner.adoptScope(compositionScope);
    scoped = handler.withScope(compositionScope);
    resolveInstalled();
    yield* suspend();
  });
  return Object.assign(
    async (request: Request) => {
      await installed;
      return scoped!(request);
    },
    { withScope: handler.withScope },
  );
}

// =============================================================================
// MOCK PROVIDER
// =============================================================================

export interface MockProviderStreamOptions {
  model?: string;
  baseUri?: string;
  apiKey?: string;
  toolChoice?: "auto" | "none" | "required";
  schema?: Record<string, unknown>;
  toolSchemas?: Array<Record<string, unknown>>;
}

export interface MockProviderCapabilities {
  thinking: boolean;
  toolCalling: boolean;
}

export interface MockProvider {
  readonly name: string;
  readonly capabilities: MockProviderCapabilities;
  stream(messages: Message[], options?: MockProviderStreamOptions): Stream<ChatEvent, ChatResult>;
}

export interface MockProviderConfig {
  /** Response text (or sequence for multiple calls) */
  responses?: string | string[];
  /** Tool calls to emit */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** Delay between tokens */
  tokenDelayMs?: number;
  /** Whether to emit thinking events */
  emitThinking?: boolean;
  /** Custom stream function for full control */
  customStream?: (
    messages: Message[],
    options?: MockProviderStreamOptions,
  ) => Stream<ChatEvent, ChatResult>;
}

/**
 * Create a mock model provider for testing.
 *
 * By default, responds with "Hello, world!" but can be configured with:
 * - Custom response text
 * - Tool calls
 * - Thinking events
 * - Custom timing
 */
export function createMockProvider(config: MockProviderConfig = {}): MockProvider {
  const {
    responses = "Hello, world!",
    toolCalls,
    tokenDelayMs = 0,
    emitThinking = false,
    customStream,
  } = config;

  let callCount = 0;

  const capabilities: MockProviderCapabilities = {
    thinking: emitThinking,
    toolCalling: !!toolCalls,
  };

  return {
    name: "mock",
    capabilities,

    stream(
      _messages: Message[],
      _options?: MockProviderStreamOptions,
    ): Stream<ChatEvent, ChatResult> {
      if (customStream) {
        return customStream(_messages, _options);
      }

      const responseText = Array.isArray(responses)
        ? (responses[callCount++ % responses.length] ?? responses[0]!)
        : responses;

      return resource(function* (provide) {
        // Tokenize response
        const words = responseText.split(" ");
        const tokens: string[] = [];
        for (let i = 0; i < words.length; i++) {
          tokens.push(i === 0 ? words[i]! : " " + words[i]);
        }

        let tokenIndex = 0;
        let thinkingEmitted = false;
        let textEmitted = false;

        const mappedToolCalls = toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));

        const result: ChatResult = {
          text: responseText,
          ...(mappedToolCalls && { toolCalls: mappedToolCalls }),
          usage: {
            promptTokens: 10,
            completionTokens: tokens.length,
            totalTokens: 10 + tokens.length,
          },
        };

        yield* provide({
          *next(): Operation<IteratorResult<ChatEvent, ChatResult>> {
            if (tokenDelayMs > 0) {
              yield* sleep(tokenDelayMs);
            }

            // Emit thinking first if enabled
            if (emitThinking && !thinkingEmitted) {
              thinkingEmitted = true;
              return {
                done: false,
                value: { type: "thinking", content: "Let me think..." },
              };
            }

            // Emit text tokens
            if (tokenIndex < tokens.length) {
              textEmitted = true;
              return {
                done: false,
                value: { type: "text", content: tokens[tokenIndex++]! },
              };
            }

            // Emit tool calls if any
            if (toolCalls && textEmitted) {
              textEmitted = false; // Reset for next check
              return {
                done: false,
                value: {
                  type: "tool_calls",
                  toolCalls: toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function" as const,
                    function: {
                      name: tc.name,
                      arguments: tc.arguments,
                    },
                  })),
                },
              };
            }

            // Done
            return { done: true, value: result };
          },
        });
      });
    },
  };
}

function testModel(): Model {
  return {
    id: "mock-model",
    name: "Mock Model",
    api: "mock",
    provider: "mock",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function textFromRuntimeContent(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === "string"
    ? content
    : content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

function usageFromProviderUsage(usage: ChatResult["usage"]): Usage {
  return {
    input: usage.promptTokens,
    output: usage.completionTokens,
    total: usage.totalTokens,
  };
}

function assistantFromProviderResult(result: ChatResult): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
      ...(result.thinking ? [{ type: "thinking" as const, text: result.thinking }] : []),
      ...(result.toolCalls ?? []).map((toolCall) => ({
        type: "toolCall" as const,
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })),
    ],
    usage: usageFromProviderUsage(result.usage),
    stopReason: result.toolCalls && result.toolCalls.length > 0 ? "toolUse" : "stop",
  };
}

function providerMessagesFromRuntimeContext(context: Parameters<Runtime["stream"]>[1]): Message[] {
  const messages: Message[] = [];

  if (context.systemPrompt) {
    messages.push({ id: "system:runtime", role: "system", content: context.systemPrompt });
  }

  for (const message of context.messages) {
    if (message.role === "system") {
      messages.push({ id: `system:${messages.length}`, role: "system", content: message.content });
    } else if (message.role === "user") {
      messages.push({
        id: `user:${messages.length}`,
        role: "user",
        content: textFromRuntimeContent(message.content),
      });
    } else if (message.role === "toolResult") {
      messages.push({
        id: `tool:${message.toolCallId}`,
        role: "tool",
        content: textFromRuntimeContent(message.content),
        tool_call_id: message.toolCallId,
        replay: { toolName: message.toolName },
      });
    } else {
      const toolCalls: ProviderToolCall[] = message.content
        .filter(
          (block): block is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
            block.type === "toolCall",
        )
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: block.arguments },
        }));
      messages.push({
        id: `assistant:${messages.length}`,
        role: "assistant",
        content: textFromRuntimeContent(message.content),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return messages;
}

export function createMockModelProviderDriver(provider: MockProvider): ModelProviderDriver {
  return {
    *stream(request) {
      return resource(function* (provide) {
        const subscription = yield* provider.stream(
          providerMessagesFromRuntimeContext(request.context),
          {
            model: request.model.id,
            ...(request.model.baseUrl ? { baseUri: request.model.baseUrl } : {}),
            ...(request.options?.apiKey ? { apiKey: request.options.apiKey } : {}),
            ...(request.context.tools
              ? { toolSchemas: request.context.tools.map((tool) => ({ ...tool })) }
              : {}),
            ...(request.options?.toolChoice ? { toolChoice: request.options.toolChoice } : {}),
            ...(request.options?.responseFormat?.schema
              ? { schema: request.options.responseFormat.schema }
              : {}),
          },
        );
        const pending: RuntimeStreamEvent[] = [];
        let text = "";
        let thinking = "";
        let contentIndex = 0;

        yield* provide({
          *next(): Operation<IteratorResult<RuntimeStreamEvent, AssistantMessage>> {
            if (pending.length > 0) {
              return { done: false, value: pending.shift()! };
            }

            const next = yield* subscription.next();
            if (next.done) {
              return { done: true, value: assistantFromProviderResult(next.value) };
            }

            const event: ChatEvent = next.value;
            const partial: AssistantMessage = {
              role: "assistant",
              content: [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...(thinking ? [{ type: "thinking" as const, text: thinking }] : []),
              ],
            };

            if (event.type === "text") {
              text += event.content;
              return {
                done: false,
                value: { type: "text_delta", contentIndex: 0, delta: event.content, partial },
              };
            }

            if (event.type === "thinking") {
              thinking += event.content;
              return {
                done: false,
                value: { type: "thinking_delta", contentIndex: 1, delta: event.content, partial },
              };
            }

            for (const toolCall of event.toolCalls) {
              pending.push({
                type: "toolcall_end",
                contentIndex: contentIndex++,
                toolCall: {
                  type: "toolCall",
                  id: toolCall.id,
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
                partial,
              });
            }

            return yield* this.next();
          },
        });
      });
    },
    *sample(request): Operation<AssistantMessage> {
      const subscription = yield* yield* this.stream(request);
      while (true) {
        const next = yield* subscription.next();
        if (next.done) {
          return next.value;
        }
      }
    },
  };
}

export function* setupMockModelProvider(provider: MockProvider): Operation<void> {
  yield* installModelProvider(createMockModelProviderDriver(provider));
  yield* ModelProviderModelContext.set(testModel());
}

// =============================================================================
// MOCK TOOLS
// =============================================================================

type MockTool = CoreToolDefinition<string, unknown, unknown, any, any>;

/**
 * Create a simple mock tool that returns its input.
 */
export function createMockTool(name: string, description: string = "A mock tool"): MockTool {
  return createTool(name)
    .description(description)
    .parameters(z.object({ input: z.string() }))
    .execute(function* (params) {
      const { input } = params as { input: string };
      return `Mock result for: ${input}`;
    }) as MockTool;
}

// =============================================================================
// INITIALIZER HOOKS
// =============================================================================

function toolEntry(tool: MockTool): ToolInventoryEntry {
  const artifacts = (
    tool as MockTool & {
      artifacts?: { parameters?: { inputProjection?: Record<string, unknown> } };
    }
  ).artifacts;
  return {
    definition: {
      name: tool.name,
      description: tool.description,
      parameters:
        artifacts?.parameters?.inputProjection ??
        z.toJSONSchema(tool.parameters as unknown as z.ZodType),
    },
  };
}

function createToolCtx(signal = new AbortController().signal): Parameters<MockTool>[0] {
  return {
    signal,
    messages: [],
    notify: function* () {},
    log: function* () {},
    elicit: function* (): Operation<never> {
      throw new Error("Test tool did not install an elicit handler");
    },
    sample: function* (): Operation<never> {
      throw new Error("Test tool did not install a sample provider");
    },
    sampleTools: function* (): Operation<never> {
      throw new Error("Test tool did not install a sample provider");
    },
    sampleSchema: function* (): Operation<never> {
      throw new Error("Test tool did not install a sample provider");
    },
  } as Parameters<MockTool>[0];
}

function createTestToolRuntime(tools: MockTool[]): ToolRuntime {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  return {
    *runtimeId() {
      return "test";
    },
    *execute(request) {
      const tool = byName.get(request.call.function.name);
      const ref = createToolExecutionRef({
        runtimeId: "test",
        callId: request.call.id,
        toolName: request.call.function.name,
      });
      if (!tool) {
        return {
          kind: "failed",
          ref,
          error: {
            code: "TOOL_NOT_FOUND",
            message: `Tool not found: ${request.call.function.name}`,
          },
        };
      }
      const params = validateToolParameters({
        schema: tool.parameters,
        params: request.call.function.arguments,
        toolName: tool.name,
        callId: request.call.id,
      });
      try {
        const invoke = yield* tool(createToolCtx(request.signal));
        const result = yield* invoke(params as never);
        return { kind: "completed", ref, result };
      } catch (error) {
        return {
          kind: "failed",
          ref,
          error: {
            code: "TOOL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    *resume(request) {
      return {
        kind: "failed",
        ref: request.ref,
        error: {
          code: "EXECUTION_NOT_FOUND",
          message: `Execution not found: ${request.ref.executionId}`,
        },
      };
    },
    *abort() {},
  };
}

/**
 * Installs the tool inventory plus one tool runtime.
 *
 * A scope holds exactly one tool runtime, so a caller supplying its own runtime
 * passes it here rather than installing a second one over the top.
 */
export function* setupMockTools(tools: MockTool[], runtime?: ToolRuntime): Operation<void> {
  yield* ToolInventoryContext.set(createToolInventory(tools.map(toolEntry)));
  yield* installToolRuntime(runtime ?? createTestToolRuntime(tools));
}

/**
 * Create request setup for testing with a mock provider and tools.
 */
export function createTestChatHandlerSetup(
  provider: MockProvider,
  tools: MockTool[] = [],
): ChatHandlerSetup {
  return function* setup() {
    yield* setupMockModelProvider(provider);
    yield* setupMockTools(tools);
  };
}

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

/**
 * Session info from stream.
 */
export interface SessionInfoEvent {
  type: "session_info";
  capabilities: { thinking: boolean; streaming: boolean; tools: string[] };
  persona: string | null;
}

/**
 * Complete event from stream (AG-UI run finished).
 */
export interface CompleteEvent {
  type: "RUN_FINISHED" | "ag_ui_run_finished";
  threadId?: string;
  runId?: string;
  run?: { threadId: string; runId: string };
}

/**
 * Error event from stream.
 */
export interface ErrorEvent {
  type: "RUN_ERROR" | "error";
  message: string;
  recoverable?: boolean;
  code?: string;
}

/**
 * Parsed result from consuming a durable chat response.
 */
export interface DurableResponseResult {
  /** All events with LSN */
  events: DurableStreamEvent[];
  /** Session info event if present */
  sessionInfo: SessionInfoEvent | null;
  /** Text accumulated from text events */
  text: string;
  /** Thinking text accumulated */
  thinking: string;
  /** Tool calls event if present */
  toolCalls: Array<{ id: string; name: string; arguments: unknown }> | null;
  /** Tool results */
  toolResults: Array<{ id: string; name: string; content: string }> | null;
  /** Complete event if present */
  complete: CompleteEvent | null;
  /** Error event if present */
  error: ErrorEvent | null;
  /** Highest LSN seen */
  lastLSN: number;
}

export function getEventsByType(result: DurableResponseResult, type: string): StreamEvent[] {
  return result.events
    .map((entry) => entry.event)
    .filter((event) => {
      const candidate = event as { type?: string };
      return candidate.type === type;
    });
}

/**
 * Consume a Response from the durable chat handler.
 * Parses NDJSON and extracts events.
 */
export async function consumeDurableResponse(response: Response): Promise<DurableResponseResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: DurableStreamEvent[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.trim()) {
        events.push(JSON.parse(buffer.trim()));
      }
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) {
        events.push(JSON.parse(line));
      }
    }
  }

  // Extract structured data
  let sessionInfo: SessionInfoEvent | null = null;
  let text = "";
  let thinking = "";
  let toolCalls: Array<{ id: string; name: string; arguments: unknown }> | null = null;
  const toolResults: Array<{ id: string; name: string; content: string }> = [];
  let complete: CompleteEvent | null = null;
  let error: ErrorEvent | null = null;
  let lastLSN = 0;

  for (const { lsn, event } of events) {
    lastLSN = Math.max(lastLSN, lsn);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = event as any;

    switch (e.type) {
      case "session_info":
        sessionInfo = e as SessionInfoEvent;
        break;
      case "TEXT_MESSAGE_CONTENT":
      case "ag_ui_text_message_content":
        text += e.delta;
        break;
      case "REASONING_MESSAGE_CONTENT":
        thinking += e.delta;
        break;
      case "thinking":
        thinking += e.content;
        break;
      case "TOOL_CALL_START":
      case "ag_ui_tool_call_start":
        if (!toolCalls) {
          toolCalls = [];
        }
        toolCalls.push({ id: e.toolCallId, name: e.toolCallName, arguments: undefined });
        break;
      case "TOOL_CALL_ARGS":
      case "ag_ui_tool_call_args": {
        const existing = toolCalls?.find((tc) => tc.id === e.toolCallId);
        if (existing) {
          try {
            existing.arguments = JSON.parse(e.delta);
          } catch {
            existing.arguments = e.delta;
          }
        }
        break;
      }
      case "TOOL_CALL_RESULT": {
        const existing = toolCalls?.find((tc) => tc.id === e.toolCallId);
        toolResults.push({
          id: e.toolCallId,
          name: e.toolCallName ?? existing?.name ?? "unknown",
          content: e.content,
        });
        break;
      }
      case "ag_ui_tool_call_result":
        toolResults.push({ id: e.toolCallId, name: e.toolCallName, content: e.content });
        break;
      case "RUN_FINISHED":
      case "ag_ui_run_finished":
        complete = e as CompleteEvent;
        break;
      case "RUN_ERROR":
      case "error":
        error = e as ErrorEvent;
        break;
    }
  }

  return {
    events,
    sessionInfo,
    text,
    thinking,
    toolCalls,
    toolResults: toolResults.length > 0 ? toolResults : null,
    complete,
    error,
    lastLSN,
  };
}

// =============================================================================
// DI SETUP HELPERS
// =============================================================================

/**
 * Set up durable streams contexts for testing.
 * Returns the setup for additional assertions.
 */
export function* useTestDurableStreams(): Operation<DurableStreamsSetup<string>> {
  return yield* setupInMemoryDurableStreams<string>();
}

// =============================================================================
// REQUEST HELPERS
// =============================================================================

/**
 * Create a chat request body.
 */
export function createChatRequest(
  messages: Message[],
  options: {
    sessionId?: string;
    conversationId?: string;
    lastLSN?: number;
    offset?: number;
    useSessionPath?: boolean;
    method?: "POST" | "HEAD" | "GET";
    live?: "long-poll" | "sse";
    timeout?: number;
    requestHeaders?: Record<string, string>;
    persona?: string;
    enabledTools?: boolean | string[];
    enabledPlugins?: string[];
    systemPrompt?: string;
  } = {},
): { request: Request; body: Record<string, unknown> } {
  const {
    sessionId,
    conversationId,
    lastLSN,
    offset,
    useSessionPath,
    method,
    live,
    timeout,
    requestHeaders,
    ...bodyOptions
  } = options;
  const effectiveMethod = method ?? (useSessionPath ? "GET" : "POST");
  const body = { messages, ...bodyOptions };

  const headers = new Headers({
    "Content-Type": "application/json",
  });

  if (requestHeaders) {
    for (const [key, value] of Object.entries(requestHeaders)) {
      headers.set(key, value);
    }
  }

  const basePath =
    useSessionPath && sessionId
      ? `http://localhost/sessions/${encodeURIComponent(sessionId)}`
      : "http://localhost/chat";
  const url = new URL(basePath);

  if (sessionId && !useSessionPath) {
    url.searchParams.set("sessionId", sessionId);
  }

  if (conversationId) {
    url.searchParams.set("conversationId", conversationId);
  }

  if (offset !== undefined) {
    url.searchParams.set("offset", String(offset));
  } else if (lastLSN !== undefined) {
    url.searchParams.set("offset", String(lastLSN));
  }

  if (live) {
    url.searchParams.set("live", live);
  }

  if (timeout !== undefined) {
    url.searchParams.set("timeout", String(timeout));
  }

  if (effectiveMethod === "HEAD" || effectiveMethod === "GET") {
    const request = new Request(url.toString(), {
      method: effectiveMethod,
      headers,
    });

    return { request, body };
  }

  const request = new Request(url.toString(), {
    method: effectiveMethod,
    headers,
    body: JSON.stringify(body),
  });

  return { request, body };
}
