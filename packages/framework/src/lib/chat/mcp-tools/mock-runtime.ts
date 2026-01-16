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
import type { Operation } from 'effection'
import type {
  MCPClientContext,
  MCPServerContext,
  ElicitResult,
  RawElicitResult,
  ElicitConfig,
  SampleConfig,
  LogLevel,
  ElicitExchange,
  McpMessage,
} from './types.ts'
import {
  MCPCapabilityError,
} from './types.ts'
import type { FinalizedMCPTool } from './builder.ts'

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
   * - RawElicitResult (simple: { action, content }) - exchange will be constructed
   * - ElicitResult (full: { action, content, exchange }) - used as-is
   */
  elicitResponses?: (RawElicitResult<any> | ElicitResult<any, any>)[]

  /**
   * Pre-programmed sampling responses.
   * Consumed in order as ctx.sample() is called.
   */
  sampleResponses?: (string | any)[]

  /**
   * Client capabilities.
   * @default { elicitation: true, sampling: true }
   */
  capabilities?: {
    elicitation?: boolean
    sampling?: boolean
  }

  /**
   * Callback for each elicit call (for assertions).
   */
  onElicit?: (config: ElicitConfig<any>) => void

  /**
   * Callback for each sample call (for assertions).
   */
  onSample?: (config: SampleConfig<any>) => void

  /**
   * Callback for each log call (for assertions).
   */
  onLog?: (level: LogLevel, message: string) => void

  /**
   * Callback for each notify call (for assertions).
   */
  onNotify?: (message: string, progress?: number) => void
}

/**
 * Mock MCP client for testing.
 */
export interface MockMCPClient {
  /** Client capabilities */
  capabilities: { elicitation: boolean; sampling: boolean }

  /** Create a context for tool execution */
  createContext(): MCPClientContext

  /** Get all elicit calls made */
  elicitCalls: ElicitConfig<any>[]

  /** Get all sample calls made */
  sampleCalls: SampleConfig<any>[]

  /** Get all log calls made */
  logCalls: Array<{ level: LogLevel; message: string }>

  /** Get all notify calls made */
  notifyCalls: Array<{ message: string; progress?: number }>
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
  const elicitResponses = [...(config.elicitResponses ?? [])]
  const sampleResponses = [...(config.sampleResponses ?? [])]

  const capabilities = {
    elicitation: config.capabilities?.elicitation ?? true,
    sampling: config.capabilities?.sampling ?? true,
  }

  const elicitCalls: ElicitConfig<any>[] = []
  const sampleCalls: SampleConfig<any>[] = []
  const logCalls: Array<{ level: LogLevel; message: string }> = []
  const notifyCalls: Array<{ message: string; progress?: number }> = []

  function createContext(): MCPClientContext {
    return {
      elicit: <T>(elicitConfig: ElicitConfig<T>): Operation<ElicitResult<unknown, T>> => {
        return {
          *[Symbol.iterator]() {
            if (!capabilities.elicitation) {
              throw new MCPCapabilityError('elicitation', 'Client does not support elicitation')
            }

            elicitCalls.push(elicitConfig)
            config.onElicit?.(elicitConfig)

            const response = elicitResponses.shift()
            if (!response) {
              throw new Error('Mock MCP client: No more elicit responses configured')
            }

            // If response already has exchange, return as-is
            if ('exchange' in response) {
              return response as ElicitResult<unknown, T>
            }

            // For decline/cancel, no exchange needed
            if (response.action !== 'accept') {
              return response as ElicitResult<unknown, T>
            }

            // Construct a mock exchange for accept responses using MCP format
            const toolCallId = `mock_elicit_${Date.now()}`
            const request: McpMessage & { role: 'assistant' } = {
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: toolCallId,
                name: 'elicit',
                input: {},
              }],
            }
            const toolResponse: McpMessage & { role: 'user' } = {
              role: 'user',
              content: [{
                type: 'tool_result',
                toolUseId: toolCallId,
                content: [{ type: 'text', text: JSON.stringify(response.content) }],
              }],
            }
            
            const exchange: ElicitExchange<unknown> = {
              context: {},
              request,
              response: toolResponse,
              messages: [request, toolResponse],
              withArguments: () => [request, toolResponse],
            }

            return {
              action: 'accept',
              content: response.content as T,
              exchange,
            }
          }
        }
      },

      sample: <T = string>(sampleConfig: SampleConfig<T>): Operation<T> => {
        return {
          *[Symbol.iterator]() {
            if (!capabilities.sampling) {
              throw new MCPCapabilityError('sampling', 'Client does not support sampling')
            }

            sampleCalls.push(sampleConfig)
            config.onSample?.(sampleConfig)

            const response = sampleResponses.shift()
            if (response === undefined) {
              throw new Error('Mock MCP client: No more sample responses configured')
            }

            return response as T
          }
        }
      },

      log: (level: LogLevel, message: string): Operation<void> => {
        return {
          *[Symbol.iterator]() {
            logCalls.push({ level, message })
            config.onLog?.(level, message)
            return
          }
        }
      },

      notify: (message: string, progress?: number): Operation<void> => {
        return {
          *[Symbol.iterator]() {
            notifyCalls.push(progress !== undefined ? { message, progress } : { message })
            config.onNotify?.(message, progress)
            return
          }
        }
      },
    }
  }

  return {
    capabilities,
    createContext,
    elicitCalls,
    sampleCalls,
    logCalls,
    notifyCalls,
  }
}

// =============================================================================
// TOOL EXECUTOR
// =============================================================================

/**
 * Options for running an MCP tool.
 */
export interface RunMCPToolOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal

  /** Tool call ID (generated if not provided) */
  callId?: string
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
  THandoff,
  TClient,
  TResult,
>(
  tool: FinalizedMCPTool<TName, TParams, THandoff, TClient, TResult>,
  params: TParams,
  client: MockMCPClient,
  options: RunMCPToolOptions = {}
): Operation<TResult> {
  return {
    *[Symbol.iterator]() {
      const callId = options.callId ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const signal = options.signal ?? new AbortController().signal

      // Check capabilities
      if (tool.requires?.elicitation && !client.capabilities.elicitation) {
        throw new MCPCapabilityError('elicitation', `Tool "${tool.name}" requires elicitation capability`)
      }
      if (tool.requires?.sampling && !client.capabilities.sampling) {
        throw new MCPCapabilityError('sampling', `Tool "${tool.name}" requires sampling capability`)
      }

      // Validate params
      const parseResult = tool.parameters.safeParse(params)
      if (!parseResult.success) {
        throw new Error(`Invalid params for tool "${tool.name}": ${parseResult.error.message}`)
      }
      const validatedParams = parseResult.data as TParams

      const serverCtx: MCPServerContext = { callId, signal }
      const clientCtx = client.createContext()

      let result: TResult

      if (tool.handoffConfig) {
        // Execute handoff pattern
        const { before, client: clientFn, after } = tool.handoffConfig

        // Phase 1: before()
        const handoff = yield* before(validatedParams, serverCtx)

        // Client phase
        const clientResult = yield* clientFn(handoff, clientCtx)

        // Phase 2: after()
        result = yield* after(handoff, clientResult, serverCtx, validatedParams)
      } else if (tool.execute) {
        // Simple execute
        result = yield* tool.execute(validatedParams, clientCtx)
      } else {
        throw new Error(`Tool "${tool.name}" has no execute or handoff config`)
      }

      return result
    }
  }
}

/**
 * Execute an MCP tool and expect it to succeed.
 * Throws if the tool execution fails.
 */
export function runMCPToolOrThrow<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
>(
  tool: FinalizedMCPTool<TName, TParams, THandoff, TClient, TResult>,
  params: TParams,
  client: MockMCPClient,
  options: RunMCPToolOptions = {}
): Operation<TResult> {
  return runMCPTool(tool, params, client, options)
}
