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
 * import { createMockMCPClient, runMCPTool } from './mock-runtime.ts'
 *
 * const mockClient = createMockMCPClient({
 *   elicitResponses: [
 *     { action: 'accept', content: { flightId: 'FL123' } },
 *   ],
 *   sampleResponses: ['Flight FL123 departs at 10am'],
 * })
 *
 * const result = yield* runMCPTool(myTool, { destination: 'NYC' }, mockClient)
 * expect(result).toBe('Booked flight FL123')
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from "effection";
import { z } from "zod";
import type {
  ToolCtx,
  ToolDefinition,
  AnyToolDefinition,
  ToolElicitResult,
  ElicitsMap,
  SampleResultBase,
  ToolMessage,
} from "@sweatpants/core";
import type {
  ElicitResult,
  WireElicitResult,
  ElicitConfig,
  LogLevel,
  ElicitExchange,
} from "./mcp-tool-types.ts";
import { McpCapabilityError as MCPCapabilityError } from "./mcp-tool-types.ts";

interface MockSampleConfig<T = unknown> {
  prompt?: string;
  messages?: readonly unknown[];
  systemPrompt?: string;
  schema?: z.ZodType<T>;
  maxTokens?: number;
  modelPreferences?: unknown;
}

interface MockMCPClientContext {
  elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<unknown, T>>;
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
   * - WireElicitResult (simple: { action, content }) - exchange will be constructed
   * - ElicitResult (full: { action, content, exchange }) - used as-is
   */
  elicitResponses?: (WireElicitResult<any> | ElicitResult<any, any>)[];

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
  onElicit?: (config: ElicitConfig<any>) => void;

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
  elicitCalls: ElicitConfig<any>[];

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

  const elicitCalls: ElicitConfig<any>[] = [];
  const sampleCalls: MockSampleConfig<any>[] = [];
  const logCalls: Array<{ level: LogLevel; message: string }> = [];
  const notifyCalls: Array<{ message: string; progress?: number }> = [];

  function createContext(): MockMCPClientContext {
    return {
      elicit: <T>(elicitConfig: ElicitConfig<T>): Operation<ElicitResult<unknown, T>> => {
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

            // If response already has exchange, return as-is
            if ("exchange" in response) {
              return response as ToolElicitResult<unknown, T>;
            }

            // For decline/cancel, no exchange needed
            if (response.action !== "accept") {
              return response as ToolElicitResult<unknown, T>;
            }

            // Construct a mock exchange for accept responses using MCP format
            const toolCallId = `mock_elicit_${Date.now()}`;
            const request: ToolMessage & { role: "assistant" } = {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolCallId,
                  name: "elicit",
                  // Keep input empty; echo data in tool_result for history
                  input: {},
                },
              ],
            };
            const toolResponse: ToolMessage & { role: "user" } = {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  toolUseId: toolCallId,
                  content: [{ type: "text", text: JSON.stringify(response.content) }],
                },
              ],
            };

            const exchange: ElicitExchange<unknown> = {
              context: {},
              request,
              response: toolResponse,
              messages: [request, toolResponse],
              withArguments: () => [request, toolResponse],
            };

            return {
              action: "accept",
              content: response.content as T,
              exchange,
            };
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
>(
  tool: ToolDefinition<TName, TParams, TResult, TElicits>,
  params: TParams,
  client: MockMCPClient,
  _options: RunMCPToolOptions = {},
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

      // Validate params
      const parseResult = tool.parameters.safeParse(params);
      if (!parseResult.success) {
        throw new Error(`Invalid params for tool "${tool.name}": ${parseResult.error.message}`);
      }
      const validatedParams = parseResult.data as TParams;

      const clientCtx = client.createContext();

      if (typeof tool !== "function") {
        throw new Error(
          `Tool "${String((tool as { name?: string }).name ?? "<unknown>")}" is not a callable ToolDefinition factory`,
        );
      }
      const invoke = yield* (tool as ToolDefinition<TName, TParams, TResult, TElicits>)(
        createCoreToolCtx(tool, clientCtx) as unknown as ToolCtx<TElicits, undefined>,
      );
      return yield* invoke(validatedParams);
    },
  };
}

function createCoreToolCtx(
  tool: AnyToolDefinition,
  clientCtx: MockMCPClientContext,
): ToolCtx<any, any> {
  // Mock context: single documented assertion; overload surface is exercised by real runtimes.
  const ctx = {
    messages: [],
    history: [],
    notify: (message: string, fraction?: number) => clientCtx.notify(message, fraction),
    log: (level: LogLevel, message: string) => clientCtx.log(level, message),
    *branch(fn: (c: ToolCtx<any, any>) => Operation<unknown>) {
      return yield* fn(ctx as unknown as ToolCtx<any, any>);
    },
    elicit: function* (
      key: string,
      request: { message: string; context?: unknown },
    ): Operation<ToolElicitResult<unknown, unknown>> {
      const def = (tool.elicits as Record<string, { response?: unknown }>)[key];
      if (!def) {
        throw new Error(`Unknown elicit key "${key}" for tool "${tool.name}"`);
      }
      const response = yield* clientCtx.elicit({
        message: request.message,
        schema: def.response as z.ZodType,
      });
      if (response.action === "accept") {
        const toolUseId = `elicit_${key}`;
        const requestMsg = {
          role: "assistant" as const,
          content: [{ type: "tool_use" as const, id: toolUseId, name: key, input: {} }],
        };
        const responseMsg = {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              toolUseId,
              content: [{ type: "text" as const, text: JSON.stringify(response.content) }],
            },
          ],
        };
        return {
          action: "accept",
          content: response.content,
          exchange: {
            context: request.context,
            request: requestMsg,
            response: responseMsg,
            messages: [requestMsg, responseMsg],
            withArguments(fn: (c: unknown) => Record<string, unknown>) {
              const args = fn(request.context);
              return [
                {
                  role: "assistant" as const,
                  content: [{ type: "tool_use" as const, id: toolUseId, name: key, input: args }],
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
