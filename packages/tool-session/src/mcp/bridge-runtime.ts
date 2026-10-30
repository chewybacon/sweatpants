import { toolFactory } from "@sweatpants/agent-sdk/internal/tool-execution";
import type { NormalizedElicitsMap, NormalizedSamplesMap } from "@sweatpants/agent-sdk";
/**
 * Bridge Runtime for In-App MCP Tool Execution
 *
 * Enables running MCP tools inside the framework (not via external MCP server).
 * When a tool calls `ctx.elicit(key, {message})`, the runtime:
 * 1. Emits an ElicitRequest to the output channel
 * 2. Suspends waiting for a response via Signal
 * 3. Validates accepted content through Standard Schema and resumes the generator
 *
 * This enables UI-driven elicitation where the client renders a component
 * and sends back the user's response.
 *
 * ## Buffered Channel Pattern
 *
 * The bridge uses a buffered channel for events. This means:
 * - Events are queued until a subscriber is ready
 * - No messages are dropped, even if subscriber connects late
 * - No sleep(0) hacks needed
 *
 * @packageDocumentation
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { requireJsonObject, type JsonObject } from "@sweatpants/foundation";
import type { ChatToolDefinition } from "@sweatpants/chat-contract";
import {
  type Operation,
  type Channel,
  type Signal,
  createChannel,
  createSignal,
  spawn,
  each,
  call,
  useAbortSignal,
} from "effection";
import { safeSchemaIssues, validateAuthoredSchema } from "@sweatpants/foundation/parser";
import {
  parseToolParameters,
  requireToolParameterResult,
  toToolParameterJsonSchema,
} from "../tool-parameters.ts";
import type { ChatContent, ChatMessage, ChatMessagePart } from "@sweatpants/chat-contract";
import type {
  McpToolContextWithElicits,
  McpToolLimits,
  ElicitId,
  ElicitRequest,
} from "./mcp-tool-types.ts";
import { McpToolTokenError } from "./mcp-tool-types.ts";
import type {
  ElicitsMap,
  LogLevel,
  SamplesMap,
  ToolDefinition,
  ToolElicitResult,
  ExtractElicitContextInput,
  ExtractElicitResponse,
  ToolSampleConfig,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SamplingToolChoice,
  SamplingToolDefinition,
  SampleToolsConfig,
  SampleToolsResult,
  SampleSchemaConfig,
  SampleSchemaResult,
} from "@sweatpants/agent-sdk";
import {
  SampleValidationError,
  type SampleExchangeCompletion,
  completeElicitExchange,
  createRawSampleExchange,
  createStructuredSampleExchange,
  type ElicitExchangeCompletion,
} from "@sweatpants/agent-sdk";

// =============================================================================
// BUFFERED CHANNEL (Queue-based, never drops messages)
// =============================================================================

/**
 * Create a sync-safe buffered channel that won't drop messages.
 *
 * Unlike useBufferedChannel (which is a resource), this returns a Channel
 * that can be created synchronously. Messages are queued until a subscriber
 * starts iterating, then forwarded in order.
 *
 * This is used by createBridgeHost where we need to create the channel
 * synchronously but don't want to drop messages.
 */
function createBufferedChannel<T>(): Channel<T, void> {
  // Queue for buffering messages until subscriber is ready
  const queue: T[] = [];
  let closed = false;
  let hasSubscriber = false;

  // Callbacks for async coordination
  let subscriberResolve: (() => void) | null = null;
  let itemResolve: (() => void) | null = null;
  let closeResolve: (() => void) | null = null;

  // The underlying channel for actual pub/sub (created lazily)
  let channel: Channel<T, void> | null = null;
  let forwarderStarted = false;

  return {
    *send(message: T) {
      if (closed) {
        return;
      }
      queue.push(message);
      if (itemResolve) {
        itemResolve();
        itemResolve = null;
      }
    },

    *close() {
      closed = true;
      if (itemResolve) {
        itemResolve();
        itemResolve = null;
      }

      // If queue is empty and no subscriber, just return
      if (queue.length === 0 && !hasSubscriber) {
        return;
      }

      // If there are queued messages but no subscriber yet,
      // wait for subscriber to start processing
      if (!hasSubscriber && queue.length > 0) {
        yield* call(
          () =>
            new Promise<void>((resolve) => {
              subscriberResolve = resolve;
            }),
        );
      }

      // Wait for forwarder to finish delivering all messages
      yield* call(
        () =>
          new Promise<void>((resolve) => {
            if (queue.length === 0 && forwarderStarted) {
              resolve();
            } else {
              closeResolve = resolve;
            }
          }),
      );

      if (channel) {
        yield* channel.close();
      }
    },

    [Symbol.iterator]: function* () {
      hasSubscriber = true;
      if (subscriberResolve) {
        subscriberResolve();
        subscriberResolve = null;
      }

      // Create the underlying channel now
      channel = createChannel<T, void>();

      // Spawn forwarder that reads from queue and forwards to channel
      yield* spawn(function* () {
        forwarderStarted = true;

        while (true) {
          // Process all queued items
          while (queue.length > 0) {
            const item = queue.shift()!;
            yield* channel!.send(item);
          }

          // If closed and queue empty, close channel and exit
          if (closed && queue.length === 0) {
            if (closeResolve) {
              closeResolve();
            }
            break;
          }

          // Wait for more items or close
          yield* call(function waitForItem(): Promise<void> {
            if (queue.length > 0 || closed) {
              return Promise.resolve();
            }
            return new Promise((resolve) => {
              itemResolve = resolve;
            });
          });
        }
      });

      // Return the channel's subscription
      return yield* channel;
    },
  };
}

// =============================================================================
// BRIDGE HOST INTERFACE
// =============================================================================

/**
 * Elicitation response from the client.
 *
 * Uses ElicitExchangeCompletion (without exchange) because the transport layer
 * only sends the action and content. The bridge-runtime constructs
 * the full ToolElicitResult with exchange internally.
 */
/** Narrow an array to the non-empty tuple type expected by guaranteed-result APIs. */
function isNonEmpty<T>(arr: T[] | undefined): arr is [T, ...T[]] {
  return Array.isArray(arr) && arr.length > 0;
}

export interface ElicitResponse<TResponse = unknown> {
  /** Matches the request id */
  id: ElicitId;

  /** Facts that complete the pending exchange; the bridge constructs local history. */
  completion: ElicitExchangeCompletion<TResponse>;
}

/**
 * Provider sample payload before exchange construction.
 * Distinct from the exported SampleExchangeCompletion union (which includes parsed/toolCalls variants).
 */
type BridgeProviderSampleResult = SampleExchangeCompletion;

/**
 * Sample response from external handler.
 */
export interface SampleResponse {
  completion: BridgeProviderSampleResult;
}

/**
 * Sample options for bridge events.
 */
export interface BridgeSampleOptions {
  systemPrompt?: string;
  maxTokens?: number;
  tools?: ChatToolDefinition[];
  toolChoice?: SamplingToolChoice;
  schema?: JsonObject;
}

function createBridgeSampleOptions(
  config: { readonly systemPrompt?: string; readonly maxTokens?: number },
  fallbackSystemPrompt: string | undefined,
  tools?: readonly SamplingToolDefinition[],
): BridgeSampleOptions {
  const options: BridgeSampleOptions = {};
  const effectiveSystemPrompt = config.systemPrompt ?? fallbackSystemPrompt;
  if (effectiveSystemPrompt !== undefined) {
    options.systemPrompt = effectiveSystemPrompt;
  }
  if (config.maxTokens !== undefined) {
    options.maxTokens = config.maxTokens;
  }
  if (tools !== undefined) {
    options.tools = tools.map((tool) => {
      const definition: ChatToolDefinition = {
        name: tool.name,
        description: tool.description ?? null,
        parameters: toToolParameterJsonSchema(tool.inputSchema),
      };
      return definition;
    });
  }
  return options;
}

/**
 * Events emitted by the bridge runtime.
 */
export type BridgeEvent =
  | { type: "elicit"; request: ElicitRequest; responseSignal: Signal<ElicitResponse, void> }
  | { type: "log"; level: LogLevel; message: string }
  | { type: "notify"; message: string; progress?: number }
  | {
      type: "sample";
      messages: ChatMessage[];
      options?: BridgeSampleOptions;
      responseSignal: Signal<SampleResponse, void>;
    };

/**
 * Sampling provider for the bridge runtime.
 *
 * Implements the LLM sampling backchannel. This is server-side,
 * so it uses the framework's configured provider.
 */
export interface BridgeSamplingProvider {
  sample(
    messages: ChatMessage[],
    options?: BridgeSampleOptions,
  ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>;
}

/**
 * Bridge host configuration.
 *
 * Note: samplingProvider is no longer part of this config.
 * Sampling is now handled via the responseSignal pattern - the event handler
 * (tool-session or runBridgeTool) is responsible for calling the sampling
 * provider and sending the response via the signal.
 */
export interface BridgeHostConfig<
  TName extends string = string,
  TParams = unknown,
  TResult = unknown,
  TElicits extends ElicitsMap = ElicitsMap,
  TSamples extends SamplesMap | true | undefined = SamplesMap | true | undefined,
> {
  /** Tool being executed */
  tool: ToolDefinition<
    StandardSchemaV1<unknown, TParams>,
    TResult,
    NormalizedElicitsMap<TElicits>,
    {},
    TName
  > & {
    readonly samples: TSamples extends SamplesMap
      ? NormalizedSamplesMap<TSamples>
      : Readonly<Record<string, never>>;
  };
  /** Optional execution limits (host-level; not a tool property) */
  limits?: McpToolLimits;

  /** Tool parameters */
  params: TParams;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /**
   * Tool call ID. Required and caller-supplied: it seeds elicit and
   * structured-sample exchange ids, which are provider-visible bytes, so it
   * must derive from durable identity rather than be minted here.
   */
  callId: string;

  /** Initial system prompt */
  systemPrompt?: string;
}

/**
 * Bridge host handle returned from createBridgeHost().
 *
 * The host runs the tool and manages the elicitation channel.
 */
export interface BridgeHost<TResult> {
  /**
   * Channel for receiving events (elicit requests, logs, etc.)
   * Client code should subscribe to this and handle events.
   */
  events: Channel<BridgeEvent, void>;

  /**
   * Run the tool to completion.
   * Returns when the tool finishes (either successfully or with error).
   */
  run(): Operation<TResult>;
}

// =============================================================================
// TOKEN TRACKING
// =============================================================================

interface TokenTracker {
  used: number;
  budget?: number;
  parent?: TokenTracker;
}

function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extract text-like facts for token estimation without changing message authority. */
function getContentText(content: ChatContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
        case "audio":
        case "video":
        case "document":
          return JSON.stringify(part.source);
      }
    })
    .join("");
}

function getMessageTextContent(message: ChatMessage): string {
  switch (message.role) {
    case "user":
    case "tool":
      return getContentText(message.content);
    case "system":
    case "developer":
      return message.content;
    case "assistant":
      return message.content
        .map((part: ChatMessagePart) => {
          switch (part.type) {
            case "text":
            case "reasoning":
              return part.text;
            case "tool-call":
              return JSON.stringify(part.toolCall.input);
            case "image":
            case "audio":
            case "video":
            case "document":
              return JSON.stringify(part.source);
          }
        })
        .join("");
  }
}

function appendRetryText(message: ChatMessage, suffix: string): ChatMessage | undefined {
  switch (message.role) {
    case "user":
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? message.content + suffix
            : [...message.content, { type: "text", text: suffix }],
      };
    case "assistant":
      return { ...message, content: [...message.content, { type: "text", text: suffix }] };
    case "system":
    case "developer":
      return { ...message, content: message.content + suffix };
    case "tool":
      return undefined;
  }
}

function textUserMessage(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function estimateTokensFromConversation(options: {
  systemPrompt?: string;
  messages: ChatMessage[];
  completion: string;
}): number {
  const system = options.systemPrompt ? estimateTokensFromText(options.systemPrompt) : 0;
  const convo = options.messages.reduce(
    (sum, msg) => sum + estimateTokensFromText(getMessageTextContent(msg)),
    0,
  );
  const completion = estimateTokensFromText(options.completion);
  return system + convo + completion;
}

function addTokens(tracker: TokenTracker, tokens: number): void {
  for (let current: TokenTracker | undefined = tracker; current; current = current.parent) {
    current.used += tokens;
    if (current.budget !== undefined && current.used > current.budget) {
      throw new McpToolTokenError(current.used, current.budget);
    }
  }
}

// =============================================================================
// TOOL EXECUTION STATE
// =============================================================================

/**
 * Mints the exchange id for one structured (`__schema__`) sample.
 *
 * These ids are provider-visible bytes: the id names the synthetic tool call
 * inside the exchange, and any later prompt that carries the exchange embeds
 * it in the token stream. It must therefore be a pure function of durable
 * identity (callId + sequence). A wall-clock or random component changes the
 * prompt prefix on every re-execution of the same logical invocation, which
 * invalidates the provider's prompt cache and breaks replay determinism.
 * Pinned by provider-prompt-stability.integration.test.ts in
 * tool-runtime-local.
 */
function nextSchemaExchangeId(state: { callId: string; sampleSeq: number }): string {
  state.sampleSeq += 1;
  return `schema_${state.callId}_${state.sampleSeq}`;
}

interface BridgeExecutionState<TElicits extends ElicitsMap> {
  readonly signal: AbortSignal;
  messages: ChatMessage[];
  systemPrompt?: string;
  limits: McpToolLimits;
  tokenTracker: TokenTracker;

  // Bridge-specific state
  toolName: string;
  callId: string;
  elicitSeq: number;
  sampleSeq: number;
  elicits: TElicits;
  elicitArtifacts: ToolDefinition["artifacts"]["elicits"];
  eventChannel: Channel<BridgeEvent, void>;
  // Note: samplingProvider removed - sampling now uses responseSignal pattern
  // The event handler (tool-session or runBridgeTool) is responsible for
  // calling the sampling provider and sending the response via the signal
}

// =============================================================================
// CONTEXT IMPLEMENTATION
// =============================================================================

function createBridgeContext<TElicits extends ElicitsMap>(
  state: BridgeExecutionState<TElicits>,
): McpToolContextWithElicits<TElicits> {
  return {
    get signal() {
      return state.signal;
    },

    // Current tool execution state
    get messages() {
      return state.messages as readonly ChatMessage[];
    },

    // LLM backchannel
    // Using type assertion because the implementation handles all overload variants,
    // but TypeScript can't verify this without conditional types at the implementation level.
    sample: ((config: ToolSampleConfig<ChatMessage>) => {
      return {
        *[Symbol.iterator]() {
          let messages: ChatMessage[];

          if ("prompt" in config && config.prompt) {
            const userMessage = textUserMessage(config.prompt);
            messages = [...state.messages, userMessage];
          } else if ("messages" in config && config.messages) {
            messages = [...config.messages];
          } else {
            throw new Error("sample() requires either prompt or messages");
          }

          // Build sample options including new fields.
          const sampleOptions = createBridgeSampleOptions(
            config,
            state.systemPrompt,
            "tools" in config ? config.tools : undefined,
          );
          if ("toolChoice" in config && config.toolChoice) {
            sampleOptions.toolChoice = config.toolChoice;
          }

          // Convert the Standard Schema to its portable JSON projection.
          if ("schema" in config && config.schema) {
            sampleOptions.schema = toToolParameterJsonSchema(config.schema);
          }

          // Create a signal for the response
          const responseSignal = createSignal<SampleResponse, void>();

          // Emit sample event with response signal
          const event: BridgeEvent = {
            type: "sample",
            messages,
            responseSignal,
            /* CONDITIONAL-SPREAD: Omit absent options from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
            ...(Object.keys(sampleOptions).length > 0 ? { options: sampleOptions } : {}),
          };
          yield* state.eventChannel.send(event);

          // Wait for response via signal
          // The listener (tool-session) will either:
          // 1. Call samplingProvider directly and send response, OR
          // 2. Forward to external MCP client and send response when received
          const subscription = yield* responseSignal;
          const next = yield* subscription.next();
          if (next.done) {
            throw new Error("Sample signal closed without response");
          }
          const result = next.value.completion;

          // If using auto-tracked mode, update tool-local messages
          if ("prompt" in config && config.prompt) {
            state.messages.push(
              { role: "user", content: config.prompt },
              { role: "assistant", content: [{ type: "text", text: result.text }] },
            );
          }

          // Track token usage
          const estimatedTokens = estimateTokensFromConversation({
            systemPrompt: sampleOptions.systemPrompt,
            messages,
            completion: result.text,
          });
          addTokens(state.tokenTracker, estimatedTokens);

          // Extract prompt text for exchange construction
          const promptText =
            "prompt" in config && config.prompt
              ? config.prompt
              : getMessageTextContent(messages[messages.length - 1] ?? textUserMessage(""));
          const promptTextStr = promptText;

          // If schema was provided, parse the response and add parsed/parseError
          if ("schema" in config && config.schema) {
            const schema = config.schema;
            try {
              const jsonParsed: unknown = JSON.parse(result.text);
              const parsedResult = validateAuthoredSchema<unknown>(schema, jsonParsed);
              const parsedIssues =
                parsedResult.status === "invalid"
                  ? parsedResult.issues
                  : parsedResult.status === "schema-error"
                    ? [{ path: [], message: `schema ${parsedResult.reason}` }]
                    : [];
              if (parsedResult.status === "ok") {
                // Create structured exchange with 3 messages
                const exchange = createStructuredSampleExchange(
                  promptTextStr,
                  parsedResult.value,
                  nextSchemaExchangeId(state),
                );
                return {
                  ...result,
                  parsed: parsedResult.value,
                  exchange,
                };
              } else {
                // Create structured exchange even for parse errors
                const exchange = createStructuredSampleExchange(
                  promptTextStr,
                  null,
                  nextSchemaExchangeId(state),
                );
                return {
                  ...result,
                  parsed: null,
                  parseError: {
                    message: safeSchemaIssues(parsedIssues)
                      .map((issue) => issue.message)
                      .join("; ")
                      .slice(0, 512),
                    rawText: result.text,
                  },
                  exchange,
                };
              }
            } catch (jsonError) {
              // Create structured exchange even for JSON parse errors
              const exchange = createStructuredSampleExchange(
                promptTextStr,
                null,
                nextSchemaExchangeId(state),
              );
              return {
                ...result,
                parsed: null,
                parseError: {
                  message: jsonError instanceof Error ? jsonError.message : "JSON parse error",
                  rawText: result.text,
                },
                exchange,
              };
            }
          }

          // Raw sample - create 2-message exchange
          const exchange = createRawSampleExchange(promptTextStr, result.text);
          return {
            ...result,
            exchange,
          };
        },
      };
    }) as McpToolContextWithElicits<TElicits>["sample"],

    // Sample with guaranteed tool calls
    sampleTools(config: SampleToolsConfig<ChatMessage>): Operation<SampleToolsResult> {
      const maxRetries = config.retries ?? 2;
      const toolChoice = config.toolChoice ?? "required";

      return {
        *[Symbol.iterator]() {
          let lastResult: SampleResultBase | SampleResultWithToolCalls | undefined;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Build messages for this attempt
            let messages: ChatMessage[];

            if ("prompt" in config && config.prompt) {
              const retryHint =
                attempt > 0
                  ? `\n\n[IMPORTANT: You must call one of the available tools. Your previous response did not include a tool call.]`
                  : "";
              const userMessage = textUserMessage(config.prompt + retryHint);
              messages = [...state.messages, userMessage];
            } else if ("messages" in config && config.messages) {
              // Messages mode - add retry hint to last message if retrying
              if (attempt > 0 && config.messages.length > 0) {
                const retryText = "\n\n[IMPORTANT: You must call one of the available tools.]";
                const lastMsg = config.messages[config.messages.length - 1]!;
                const updated = appendRetryText(lastMsg, retryText);
                messages = updated
                  ? [...config.messages.slice(0, -1), updated]
                  : [...config.messages, textUserMessage(retryText)];
              } else {
                messages = [...config.messages];
              }
            } else {
              throw new Error("sampleTools() requires either prompt or messages");
            }

            // Carry the authored portable projection.
            const sampleOptions = createBridgeSampleOptions(
              config,
              state.systemPrompt,
              config.tools,
            );
            sampleOptions.toolChoice = toolChoice;

            // Create response signal and send sample event
            const responseSignal = createSignal<SampleResponse, void>();
            const event: BridgeEvent = {
              type: "sample",
              messages,
              responseSignal,
              /* CONDITIONAL-SPREAD: Omit absent options from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
              ...(Object.keys(sampleOptions).length > 0 ? { options: sampleOptions } : {}),
            };
            yield* state.eventChannel.send(event);

            // Wait for response
            const subscription = yield* responseSignal;
            const next = yield* subscription.next();
            if (next.done) {
              throw new Error("Sample signal closed without response");
            }
            const result = next.value.completion;

            // Extract prompt text for exchange
            const promptText =
              "prompt" in config && config.prompt
                ? config.prompt
                : getMessageTextContent(messages[messages.length - 1] ?? textUserMessage(""));
            const promptTextStr = promptText;

            // Create exchange for this result
            const exchange = createRawSampleExchange(promptTextStr, result.text);
            const resultWithExchange = { ...result, exchange };
            lastResult = resultWithExchange;

            // Track token usage
            const estimatedTokens = estimateTokensFromConversation({
              /* CONDITIONAL-SPREAD: Omit absent systemPrompt from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
              ...(sampleOptions.systemPrompt !== undefined
                ? { systemPrompt: sampleOptions.systemPrompt }
                : {}),
              messages,
              completion: result.text,
            });
            addTokens(state.tokenTracker, estimatedTokens);

            // Validate: must have tool calls
            if (
              result.stopReason === "toolUse" &&
              "toolCalls" in result &&
              isNonEmpty(result.toolCalls)
            ) {
              // Update tool-local messages if using prompt mode
              if ("prompt" in config && config.prompt) {
                state.messages.push(
                  { role: "user", content: config.prompt },
                  { role: "assistant", content: [{ type: "text", text: result.text }] },
                );
              }

              return {
                text: result.text,
                model: result.model,
                stopReason: "toolUse" as const,
                toolCalls: result.toolCalls,
                exchange: resultWithExchange.exchange,
              };
            }
          }

          // All retries exhausted
          throw new SampleValidationError(
            "sampleTools",
            maxRetries + 1,
            lastResult!,
            `sampleTools failed after ${maxRetries + 1} attempts: model did not return tool calls`,
          );
        },
      };
    },

    // Sample with guaranteed parsed schema
    sampleSchema<T>(config: SampleSchemaConfig<T, ChatMessage>): Operation<SampleSchemaResult<T>> {
      const maxRetries = config.retries ?? 2;

      return {
        *[Symbol.iterator]() {
          let lastResult: SampleResultBase | SampleResultWithParsed<T> | undefined;
          let lastError: string | undefined;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Build messages for this attempt
            let messages: ChatMessage[];

            if ("prompt" in config && config.prompt) {
              const retryHint =
                attempt > 0 && lastError
                  ? `\n\n[IMPORTANT: Your previous response was invalid: ${lastError}. Please respond with valid JSON matching the schema.]`
                  : "";
              const userMessage = textUserMessage(config.prompt + retryHint);
              messages = [...state.messages, userMessage];
            } else if ("messages" in config && config.messages) {
              // Messages mode - add retry hint to last message if retrying
              if (attempt > 0 && config.messages.length > 0 && lastError) {
                const retryText = `\n\n[IMPORTANT: Your previous response was invalid: ${lastError}. Please respond with valid JSON.]`;
                const lastMsg = config.messages[config.messages.length - 1]!;
                const updated = appendRetryText(lastMsg, retryText);
                messages = updated
                  ? [...config.messages.slice(0, -1), updated]
                  : [...config.messages, textUserMessage(retryText)];
              } else {
                messages = [...config.messages];
              }
            } else {
              throw new Error("sampleSchema() requires either prompt or messages");
            }

            // Convert the Standard Schema to its portable JSON projection.
            const sampleOptions = createBridgeSampleOptions(config, state.systemPrompt);
            sampleOptions.schema = toToolParameterJsonSchema(config.schema);

            // Create response signal and send sample event
            const responseSignal = createSignal<SampleResponse, void>();
            const event: BridgeEvent = {
              type: "sample",
              messages,
              responseSignal,
              /* CONDITIONAL-SPREAD: Omit absent options from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
              ...(Object.keys(sampleOptions).length > 0 ? { options: sampleOptions } : {}),
            };
            yield* state.eventChannel.send(event);

            // Wait for response
            const subscription = yield* responseSignal;
            const next = yield* subscription.next();
            if (next.done) {
              throw new Error("Sample signal closed without response");
            }
            const result = next.value.completion;

            // Track token usage
            const estimatedTokens = estimateTokensFromConversation({
              /* CONDITIONAL-SPREAD: Omit absent systemPrompt from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
              ...(sampleOptions.systemPrompt !== undefined
                ? { systemPrompt: sampleOptions.systemPrompt }
                : {}),
              messages,
              completion: result.text,
            });
            addTokens(state.tokenTracker, estimatedTokens);

            // Extract prompt text for exchange
            const promptText =
              "prompt" in config && config.prompt
                ? config.prompt
                : getMessageTextContent(messages[messages.length - 1] ?? textUserMessage(""));
            const promptTextStr = promptText;

            // Parse schema
            const schema = config.schema;
            try {
              const jsonParsed: unknown = JSON.parse(result.text);
              const parsedResult = validateAuthoredSchema<T>(schema, jsonParsed);
              const parsedIssues =
                parsedResult.status === "invalid"
                  ? parsedResult.issues
                  : parsedResult.status === "schema-error"
                    ? [{ path: [], message: `schema ${parsedResult.reason}` }]
                    : [];
              if (parsedResult.status === "ok") {
                // Update tool-local messages if using prompt mode
                if ("prompt" in config && config.prompt) {
                  state.messages.push(
                    { role: "user", content: config.prompt },
                    { role: "assistant", content: [{ type: "text", text: result.text }] },
                  );
                }

                // Create structured exchange
                const exchange = createStructuredSampleExchange(
                  promptTextStr,
                  parsedResult.value,
                  nextSchemaExchangeId(state),
                );

                return {
                  text: result.text,
                  model: result.model,
                  stopReason: result.stopReason,
                  parsed: parsedResult.value,
                  exchange,
                };
              } else {
                lastError = safeSchemaIssues(parsedIssues)
                  .map((issue) => issue.message)
                  .join("; ")
                  .slice(0, 512);
                const exchange = createStructuredSampleExchange(
                  promptTextStr,
                  null,
                  nextSchemaExchangeId(state),
                );
                lastResult = {
                  ...result,
                  parsed: null,
                  parseError: {
                    message: safeSchemaIssues(parsedIssues)
                      .map((issue) => issue.message)
                      .join("; ")
                      .slice(0, 512),
                    rawText: result.text,
                  },
                  exchange,
                };
              }
            } catch (jsonError) {
              lastError = jsonError instanceof Error ? jsonError.message : "JSON parse error";
              const exchange = createStructuredSampleExchange(
                promptTextStr,
                null,
                nextSchemaExchangeId(state),
              );
              lastResult = {
                ...result,
                parsed: null,
                parseError: {
                  message: lastError,
                  rawText: result.text,
                },
                exchange,
              };
            }
          }

          // All retries exhausted
          throw new SampleValidationError(
            "sampleSchema",
            maxRetries + 1,
            lastResult! as SampleResultBase,
            `sampleSchema failed after ${maxRetries + 1} attempts: ${lastError}`,
          );
        },
      };
    },

    // User backchannel - KEYED elicitation
    elicit<K extends keyof TElicits & string>(
      key: K,
      options: ExtractElicitContextInput<TElicits[K]> extends undefined
        ? { message: string }
        : { message: string; context: ExtractElicitContextInput<TElicits[K]> },
    ): Operation<
      ToolElicitResult<ExtractElicitContextInput<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>
    > {
      return {
        *[Symbol.iterator]() {
          // Get the elicit definition for this key
          const definition = state.elicits[key];
          if (!definition) {
            throw new Error(`Unknown elicitation key "${key}" for tool "${state.toolName}"`);
          }

          // Extract response schema from definition
          const responseSchema = definition.response;

          // Increment sequence for this call
          const seq = state.elicitSeq++;

          // Build the structured ID
          const id: ElicitId = {
            toolName: state.toolName,
            key,
            callId: state.callId,
            seq,
          };

          // Canonical dialect: { message, context? }
          const { message } = options;
          const contextData = "context" in options ? options.context : undefined;

          const artifact = state.elicitArtifacts[key];
          // The author already supplied the wire projection, including schemas
          // with transforms that cannot be converted to JSON Schema at runtime.
          const {
            $id: _id,
            $schema: _schema,
            ...baseSchema
          } = requireJsonObject(
            artifact.response.inputProjection,
            `tool ${state.toolName} elicitation ${key} response`,
          );

          // Build the request
          const request: ElicitRequest<K, any> = {
            id,
            key,
            toolName: state.toolName,
            callId: state.callId,
            seq,
            message,
            schema: {
              standard: responseSchema,
              json: baseSchema,
            },
            /* CONDITIONAL-SPREAD: Omit absent context from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
            ...(contextData !== undefined ? { context: contextData } : {}),
          };

          // Create a signal for the response
          const responseSignal = createSignal<ElicitResponse, void>();

          // Emit the elicit event with the signal
          yield* state.eventChannel.send({ type: "elicit", request, responseSignal });

          // Wait for response via signal
          const subscription = yield* responseSignal;
          const next = yield* subscription.next();
          if (next.done) {
            throw new Error(`Elicit signal closed without response for key "${key}"`);
          }
          const response = next.value;

          // Validate the response matches our request
          if (
            response.id.toolName !== id.toolName ||
            response.id.key !== id.key ||
            response.id.callId !== id.callId ||
            response.id.seq !== id.seq
          ) {
            throw new Error(
              `Elicit response mismatch: expected ${JSON.stringify(id)}, got ${JSON.stringify(response.id)}`,
            );
          }

          return yield* completeElicitExchange<
            ExtractElicitContextInput<TElicits[K]>,
            ExtractElicitResponse<TElicits[K]>
          >({
            key,
            message,
            context: contextData as ExtractElicitContextInput<TElicits[K]>,
            exchangeId: `elicit_${id.callId}_${id.seq}`,
            responseSchema,
            completion: response.completion,
          });
        },
      };
    },

    // Logging
    log(level: LogLevel, message: string): Operation<void> {
      return state.eventChannel.send({ type: "log", level, message });
    },

    notify(message: string, progress?: number): Operation<void> {
      return state.eventChannel.send({
        type: "notify",
        message,
        /* CONDITIONAL-SPREAD: Omit absent progress from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
        ...(progress !== undefined ? { progress } : {}),
      });
    },
  };
}

// =============================================================================
// BRIDGE HOST IMPLEMENTATION
// =============================================================================

/**
 * Create a bridge host for running an MCP tool in-app.
 *
 * The host manages the tool's execution and provides channels for
 * elicitation and events.
 *
 * @example
 * ```typescript
 * const host = createBridgeHost({
 *   tool: bookFlightTool,
 *   params: { destination: 'NYC' },
 *   samplingProvider: myProvider,
 * })
 *
 * // Subscribe to events in parallel
 * yield* spawn(function* () {
 *   for (const event of yield* each(host.events)) {
 *     if (event.type === 'elicit') {
 *       // Render UI for elicitation
 *       const userResponse = yield* showUI(event.request)
 *       // Send response via the signal included in the event
 *       event.responseSignal.send({ id: event.request.id, completion: userResponse })
 *     }
 *     yield* each.next()
 *   }
 * })
 *
 * // Run the tool
 * const result = yield* host.run()
 * ```
 */
export function createBridgeHost<
  TName extends string,
  TParams,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined = SamplesMap | true | undefined,
>(config: BridgeHostConfig<TName, TParams, TResult, TElicits, TSamples>): BridgeHost<TResult> {
  // Use a buffered channel to avoid subscribe-before-send race condition.
  // Messages are queued until a subscriber starts iterating.
  const eventChannel = createBufferedChannel<BridgeEvent>();

  const callId = config.callId;

  return {
    events: eventChannel,

    run(): Operation<TResult> {
      return {
        *[Symbol.iterator]() {
          const { tool, params, limits: overrideLimits, systemPrompt } = config;
          const validatedParams = requireToolParameterResult(
            parseToolParameters<TParams>({
              schema: tool.parameters,
              params,
              toolName: tool.name,
              callId,
            }),
            { toolName: tool.name, callId },
          );

          // Merge limits (host options only; tools no longer carry limits)
          const limits: McpToolLimits = {
            ...(config as { limits?: McpToolLimits }).limits,
            ...overrideLimits,
          };

          const rootTokenTracker: TokenTracker = { used: 0 };
          if (limits.maxTokens !== undefined) {
            rootTokenTracker.budget = limits.maxTokens;
          }

          // Create initial tool execution state
          const signal = config.signal ?? (yield* useAbortSignal());
          const initialState: BridgeExecutionState<TElicits> = {
            signal,
            messages: [],
            limits,
            tokenTracker: rootTokenTracker,
            // Bridge state
            toolName: tool.name,
            callId,
            elicitSeq: 0,
            sampleSeq: 0,
            elicits: tool.elicits as TElicits,
            elicitArtifacts: tool.artifacts.elicits,
            eventChannel,
          };

          if (systemPrompt !== undefined) {
            initialState.systemPrompt = systemPrompt;
          }

          let result: TResult;

          const toolCtx = createBridgeContext(initialState);
          const invoke = yield* toolFactory(tool)(toolCtx);
          result = yield* invoke(validatedParams);

          // Close channel when done
          yield* eventChannel.close();

          return result;
        },
      };
    },
  };
}

// =============================================================================
// CONVENIENCE: RUN WITH AUTO-HANDLER
// =============================================================================

/**
 * Handler map for elicitation requests.
 * Each key maps to a generator that handles that elicitation.
 *
 * Handlers return ElicitExchangeCompletion (without exchange) - the bridge-runtime
 * constructs the exchange internally when the result is accepted.
 */
export type BridgeElicitHandlers<TElicits extends ElicitsMap> = {
  [K in keyof TElicits]: (
    request: ElicitRequest<K & string, any>,
  ) => Operation<ElicitExchangeCompletion<any>>;
};

/**
 * Run a bridgeable tool with handlers for elicitation.
 *
 * This is a convenience wrapper that wires up the event loop.
 * For more control, use createBridgeHost() directly.
 *
 * @example
 * ```typescript
 * const result = yield* runBridgeTool({
 *   tool: bookFlightTool,
 *   params: { destination: 'NYC' },
 *   samplingProvider: myProvider,
 *   handlers: {
 *     pickFlight: function* (req) {
 *       // Show UI, get user response
 *       return { action: 'accept', content: { flightId: 'FL123' } }
 *     },
 *     confirm: function* (req) {
 *       return { action: 'accept', content: { ok: true } }
 *     },
 *   },
 * })
 * ```
 */
export function runBridgeTool<
  TName extends string,
  TParams,
  TResult,
  TElicits extends ElicitsMap,
>(config: {
  tool: ToolDefinition<
    StandardSchemaV1<unknown, TParams>,
    TResult,
    NormalizedElicitsMap<TElicits>,
    {},
    TName
  >;
  params: TParams;
  samplingProvider: BridgeSamplingProvider;
  handlers: BridgeElicitHandlers<TElicits>;
  signal?: AbortSignal;
  callId?: string;
  limits?: McpToolLimits;
  systemPrompt?: string;
  onLog?: (level: LogLevel, message: string) => void;
  onNotify?: (message: string, progress?: number) => void;
  onSample?: (
    messages: ChatMessage[],
    options?: { systemPrompt?: string; maxTokens?: number },
  ) => void;
}): Operation<TResult> {
  return {
    *[Symbol.iterator]() {
      const callId = config.callId ?? config.tool.name;
      const params = requireToolParameterResult(
        parseToolParameters<TParams>({
          schema: config.tool.parameters,
          params: config.params,
          toolName: config.tool.name,
          callId,
        }),
        { toolName: config.tool.name, callId },
      );

      // createBridgeHost now uses a buffered channel internally,
      // so no sleep(0) hacks are needed. Events are queued until subscriber is ready.
      const hostConfig: BridgeHostConfig<TName, TParams, TResult, TElicits> = {
        tool: config.tool,
        params,
        callId,
      };

      // Only add optional properties if defined
      if (config.signal !== undefined) {
        hostConfig.signal = config.signal;
      }
      if (config.limits !== undefined) {
        hostConfig.limits = config.limits;
      }
      if (config.systemPrompt !== undefined) {
        hostConfig.systemPrompt = config.systemPrompt;
      }

      const host = createBridgeHost(hostConfig);

      // Spawn event handler
      yield* spawn(function* () {
        for (const event of yield* each(host.events)) {
          switch (event.type) {
            case "elicit": {
              const handler = config.handlers[event.request.key as keyof TElicits];
              if (!handler) {
                throw new Error(`No handler for elicitation key "${event.request.key}"`);
              }
              const result = yield* handler(
                event.request as ElicitRequest<keyof TElicits & string, StandardSchemaV1>,
              );
              event.responseSignal.send({ id: event.request.id, completion: result });
              break;
            }
            case "log":
              config.onLog?.(event.level, event.message);
              break;
            case "notify":
              config.onNotify?.(event.message, event.progress);
              break;
            case "sample": {
              // Call the observability callback
              config.onSample?.(event.messages, event.options);
              // Call the sampling provider and send response back to bridge
              const sampleResult = yield* config.samplingProvider.sample(
                event.messages,
                event.options,
              );
              event.responseSignal.send({ completion: sampleResult });
              break;
            }
          }
          yield* each.next();
        }
      });

      // No sleep(0) needed! The buffered channel queues events until subscriber iterates.
      const result = yield* host.run();

      return result;
    },
  };
}
