/**
 * Mock MCP Runtime for Testing
 *
 * Provides a mock MCP client and executor for testing MCP tools
 * without a real MCP transport.
 *
 * ## Usage
 *
 * @example Basic test
 * ```typescript
 * import {
  createMockMCPClient,
  runMCPTool } from './mock-runtime.ts'
 *
 * const mockClient = createMockMCPClient({
 *   elicitResponses: [
 *     { action: 'accept',
  content: { flightId: 'FL123' } },
  *   ],
  *   sampleResponses: ['Flight FL123 departs at 10am'],
  * })
 *
 * const result = yield* runMCPTool(myTool,
  { destination: 'NYC' },
  mockClient)
 * expect(result).toBe('Booked flight FL123')
 * ```
 *
 * @packageDocumentation
 */
import { useAbortSignal, type Operation } from "effection";
import type { ChatAssistantMessage, ChatToolResultMessage } from "@sweatpants/chat-contract";
import type { Json } from "@sweatpants/foundation";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { safeSchemaIssues, validateAuthoredSchema } from "@sweatpants/foundation/parser";
import type {
  ToolCtx,
  ToolDefinition,
  RuntimeTool,
  ToolElicitResult,
  ElicitExchangeCompletion,
  ElicitsMap,
  LogLevel,
  SampleResultBase,
  SamplesMap,
} from "@sweatpants/agent-sdk";
import { completeElicitExchange } from "@sweatpants/agent-sdk";
import type { ClientElicitConfig } from "./mcp-tool-types.ts";
import { McpCapabilityError as MCPCapabilityError } from "./mcp-tool-types.ts";

interface MockSampleConfig<T = unknown> {
  prompt?: string;
  messages?: readonly unknown[];
  systemPrompt?: string;
  schema?: StandardSchemaV1<unknown, T>;
  maxTokens?: number;
  modelPreferences?: unknown;
}

interface MockMCPClientContext {
  elicit<T>(config: ClientElicitConfig<T>): Operation<ToolElicitResult<unknown, T>>;
  sample<T = string>(config: MockSampleConfig<T>): Operation<T>;
  log(level: LogLevel, message: string): Operation<void>;
  notify(message: string, progress?: number): Operation<void>;
}

// =============================================================================
// MOCK CLIENT CONFIGURATION
// =============================================================================

/**
 * Configuration for creating a mock MCP client.
 */
export interface MockMCPClientConfig {
  /**
   * Pre-programmed elicitation responses.
   * Consumed in order as ctx.elicit() is called.
   *
   * Can be either:
   * - ElicitExchangeCompletion (simple: { action, content }) - exchange will be constructed
   * - ToolElicitResult (full: { action, content, exchange }) - used as-is
   */
  elicitResponses?: (ElicitExchangeCompletion<any> | ToolElicitResult<any, any>)[];

  /**
   * Pre-programmed sampling responses.
   * Consumed in order as ctx.sample() is called.
   */
  sampleResponses?: (string | any)[];

  /**
   * Client capabilities.
   * @default { elicitation: true, sampling: true }
   */
  capabilities?: {
    elicitation?: boolean;
    sampling?: boolean;
  };

  /**
   * Callback for each elicit call (for assertions).
   */
  onElicit?: (config: ClientElicitConfig<any>) => void;

  /**
   * Callback for each sample call (for assertions).
   */
  onSample?: (config: MockSampleConfig<any>) => void;

  /**
   * Callback for each log call (for assertions).
   */
  onLog?: (level: LogLevel, message: string) => void;

  /**
   * Callback for each notify call (for assertions).
   */
  onNotify?: (message: string, progress?: number) => void;
}

/**
 * Mock MCP client for testing.
 */
export interface MockMCPClient {
  /** Client capabilities */
  capabilities: { elicitation: boolean; sampling: boolean };

  /** Create a context for tool execution */
  createContext(): MockMCPClientContext;

  /** Get all elicit calls made */
  elicitCalls: ClientElicitConfig<any>[];

  /** Get all sample calls made */
  sampleCalls: MockSampleConfig<any>[];

  /** Get all log calls made */
  logCalls: Array<{ level: LogLevel; message: string }>;

  /** Get all notify calls made */
  notifyCalls: Array<{ message: string; progress?: number }>;
}

/**
 * Create a mock MCP client for testing.
 *
 * @example
 * ```typescript
 * const client = createMockMCPClient({
 *   elicitResponses: [
 *     { action: 'accept', content: { choice: 'A' } },
 *     { action: 'decline' },
 *   ],
 *   sampleResponses: ['Generated text'],
 * })
 *
 * // After running tool...
 * expect(client.elicitCalls).toHaveLength(2)
 * expect(client.sampleCalls[0].prompt).toContain('Summarize')
 * ```
 */
export function createMockMCPClient(config: MockMCPClientConfig = {}): MockMCPClient {
  const elicitResponses = [...(config.elicitResponses ?? [])];
  const sampleResponses = [...(config.sampleResponses ?? [])];

  const capabilities = {
    elicitation: config.capabilities?.elicitation ?? true,
    sampling: config.capabilities?.sampling ?? true,
  };

  const elicitCalls: ClientElicitConfig<any>[] = [];
  const sampleCalls: MockSampleConfig<any>[] = [];
  const logCalls: Array<{ level: LogLevel; message: string }> = [];
  const notifyCalls: Array<{ message: string; progress?: number }> = [];
  let elicitSequence = 0;

  function createContext(): MockMCPClientContext {
    return {
      elicit: <T>(elicitConfig: ClientElicitConfig<T>): Operation<ToolElicitResult<unknown, T>> => {
        return {
          *[Symbol.iterator]() {
            if (!capabilities.elicitation) {
              throw new MCPCapabilityError("elicitation", "Client does not support elicitation");
            }

            elicitCalls.push(elicitConfig);
            config.onElicit?.(elicitConfig);

            const response = elicitResponses.shift();
            if (!response) {
              throw new Error("Mock MCP client: No more elicit responses configured");
            }

            if ("exchange" in response) {
              return response;
            }

            return yield* completeElicitExchange({
              key: "elicit",
              message: elicitConfig.message,
              context: undefined,
              exchangeId: `mock_elicit_${++elicitSequence}`,
              responseSchema: elicitConfig.schema,
              completion: response,
            });
          },
        };
      },

      sample: <T = string>(sampleConfig: MockSampleConfig<T>): Operation<T> => {
        return {
          *[Symbol.iterator]() {
            if (!capabilities.sampling) {
              throw new MCPCapabilityError("sampling", "Client does not support sampling");
            }

            sampleCalls.push(sampleConfig);
            config.onSample?.(sampleConfig);

            const response = sampleResponses.shift();
            if (response === undefined) {
              throw new Error("Mock MCP client: No more sample responses configured");
            }

            return response as T;
          },
        };
      },

      log: (level: LogLevel, message: string): Operation<void> => {
        return {
          *[Symbol.iterator]() {
            logCalls.push({ level, message });
            config.onLog?.(level, message);
            return;
          },
        };
      },

      notify: (message: string, progress?: number): Operation<void> => {
        return {
          *[Symbol.iterator]() {
            notifyCalls.push(progress !== undefined ? { message, progress } : { message });
            config.onNotify?.(message, progress);
            return;
          },
        };
      },
    };
  }

  return {
    capabilities,
    createContext,
    elicitCalls,
    sampleCalls,
    logCalls,
    notifyCalls,
  };
}

// =============================================================================
// TOOL EXECUTOR
// =============================================================================

/**
 * Options for running an MCP tool.
 */
export interface RunMCPToolOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Tool call ID (generated if not provided) */
  callId?: string;
}

/**
 * Execute an MCP tool with a mock client.
 *
 * @param tool - The MCP tool to execute
 * @param params - Tool parameters
 * @param client - Mock MCP client
 * @param options - Execution options
 * @returns Tool result
 *
 * @example
 * ```typescript
 * const result = yield* runMCPTool(
 *   myTool,
 *   { input: 'test' },
 *   mockClient
 * )
 * ```
 */
export function runMCPTool<
  TName extends string,
  TParams,
  TResult,
  TElicits extends ElicitsMap = {},
  TSamples extends SamplesMap | true | undefined = undefined,
>(
  tool: ToolDefinition<TName, TParams, TResult, TElicits, TSamples>,
  params: TParams,
  client: MockMCPClient,
  options: RunMCPToolOptions = {},
): Operation<TResult> {
  return {
    *[Symbol.iterator]() {
      const requires = tool.capabilities;

      // Check capabilities
      if (requires?.elicitation && !client.capabilities.elicitation) {
        throw new MCPCapabilityError(
          "elicitation",
          `Tool "${tool.name}" requires elicitation capability`,
        );
      }
      if (requires?.sampling && !client.capabilities.sampling) {
        throw new MCPCapabilityError(
          "sampling",
          `Tool "${tool.name}" requires sampling capability`,
        );
      }

      // Validate params through the synchronous authored Standard Schema contract.
      const parseResult = validateAuthoredSchema(tool.parameters, params);
      if (parseResult.status === "schema-error") {
        throw new Error(`Tool "${tool.name}" schema implementation failed`);
      }
      if (parseResult.status === "invalid") {
        throw new Error(
          `Invalid params for tool "${tool.name}": ${safeSchemaIssues(parseResult.issues)
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join("; ")}`,
        );
      }
      const validatedParams = parseResult.value as TParams;

      const clientCtx = client.createContext();
      const signal = options.signal ?? (yield* useAbortSignal());

      if (typeof tool !== "function") {
        throw new Error(
          `Tool "${String((tool as { name?: string }).name ?? "<unknown>")}" is not a callable ToolDefinition factory`,
        );
      }
      // SAFETY: createCoreToolCtx supplies the common runtime services; the
      // selected ToolDefinition carries the exact elicitation/sampling types.
      const toolContext = createCoreToolCtx(tool, clientCtx, signal) as unknown as ToolCtx<
        TElicits,
        TSamples
      >;
      const invoke = yield* tool(toolContext);
      return yield* invoke(validatedParams);
    },
  };
}

function createCoreToolCtx(
  tool: RuntimeTool,
  clientCtx: MockMCPClientContext,
  signal: AbortSignal,
): ToolCtx<any, any> {
  // Mock context: single documented assertion; overload surface is exercised by real runtimes.
  const ctx = {
    signal,
    messages: [],
    notify: (message: string, fraction?: number) => clientCtx.notify(message, fraction),
    log: (level: LogLevel, message: string) => clientCtx.log(level, message),
    elicit: function* (
      key: string,
      request: { message: string; context?: unknown },
    ): Operation<ToolElicitResult<unknown, unknown>> {
      const def = (tool.elicits as Record<string, { response?: StandardSchemaV1 }>)[key];
      if (!def?.response) {
        throw new Error(`Elicit key "${key}" has no Standard Schema authority`);
      }
      if (!def) {
        throw new Error(`Unknown elicit key "${key}" for tool "${tool.name}"`);
      }
      const response = yield* clientCtx.elicit({
        message: request.message,
        schema: def.response,
      });
      if (response.action === "accept") {
        const toolUseId = `elicit_${key}`;
        const requestMsg: ChatAssistantMessage = {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCall: { id: toolUseId, name: key, input: {}, thoughtSignature: null },
            },
          ],
        };
        const responseMsg: ChatToolResultMessage = {
          role: "tool",
          toolCallId: toolUseId,
          name: key,
          content: [{ type: "text", text: JSON.stringify(response.content) }],
          isError: false,
        };
        return {
          action: "accept",
          content: response.content,
          exchange: {
            context: request.context,
            request: requestMsg,
            response: responseMsg,
            messages: [requestMsg, responseMsg],
            withArguments(fn: (c: unknown) => Json) {
              const args = fn(request.context);
              return [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "tool-call",
                      toolCall: { id: toolUseId, name: key, input: args, thoughtSignature: null },
                    },
                  ],
                },
                responseMsg,
              ];
            },
          },
        };
      }
      return { action: response.action };
    },
    sample: function* (...args: unknown[]): Operation<SampleResultBase> {
      const key = typeof args[0] === "string" ? args[0] : undefined;
      const request = (key ? args[1] : args[0]) as Record<string, unknown>;
      const response = yield* clientCtx.sample(request as unknown as MockSampleConfig<unknown>);
      const text =
        typeof response === "string"
          ? response
          : String((response as { text?: string })?.text ?? "");
      const userMsg = {
        role: "user" as const,
        content: [{ type: "text" as const, text: String(request["prompt"] ?? "") }],
      };
      const asstMsg = { role: "assistant" as const, content: [{ type: "text" as const, text }] };
      return {
        text,
        exchange: {
          request: userMsg,
          response: asstMsg,
          messages: [userMsg, asstMsg],
        },
      };
    },
    sampleTools: function* (): Operation<never> {
      throw new Error("sampleTools not implemented in mock-runtime core ctx");
    },
    sampleSchema: function* (): Operation<never> {
      throw new Error("sampleSchema not implemented in mock-runtime core ctx");
    },
  };
  return ctx as unknown as ToolCtx<any, any>;
}
