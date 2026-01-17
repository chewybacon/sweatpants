/**
 * Mock Branch Runtime for Testing
 *
 * Provides a mock MCP client for testing branch-based tools
 * without a real MCP transport.
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type {
  BranchMCPClient,
  RunBranchToolOptions,
} from './branch-runtime.ts'
import { runBranchTool } from './branch-runtime.ts'
import type {
  Message,
  SampleResult,
  ElicitConfig,
  ElicitResult,
  RawElicitResult,
  ElicitExchange,
  LogLevel,
  McpMessage,
} from './mcp-tool-types.ts'
import { McpCapabilityError, createRawSampleExchange } from './mcp-tool-types.ts'
import type { FinalizedMcpTool, FinalizedMcpToolWithElicits } from './mcp-tool-builder.ts'
import type { ElicitsMap } from './mcp-tool-types.ts'

// Legacy type aliases for backward compatibility
const MCPCapabilityError = McpCapabilityError

// Type alias that accepts both FinalizedMcpTool and FinalizedMcpToolWithElicits
type FinalizedBranchTool<TName extends string, TParams, THandoff, TClient, TResult> = 
  | FinalizedMcpTool<TName, TParams, THandoff, TClient, TResult>
  | FinalizedMcpToolWithElicits<TName, TParams, THandoff, TClient, TResult, ElicitsMap>

// =============================================================================
// MOCK CLIENT CONFIGURATION
// =============================================================================

/**
 * Configuration for creating a mock branch MCP client.
 */
export interface MockBranchClientConfig {
  /**
   * Pre-programmed sample responses.
   * Can be:
   * - string: Simple text response
   * - SampleResult: Full response object
   * - (messages: Message[]) => string | SampleResult: Dynamic response
   */
  sampleResponses?: Array<
    | string
    | SampleResult
    | ((messages: Message[]) => string | SampleResult)
  >

  /**
   * Pre-programmed elicitation responses.
   * Consumed in order as ctx.elicit() is called.
   * 
   * The mock will automatically construct the ElicitExchange wrapper.
   * Just provide the raw response (action and content).
   */
  elicitResponses?: RawElicitResult<any>[]

  /**
   * Client capabilities.
   * @default { elicitation: true, sampling: true }
   */
  capabilities?: {
    elicitation?: boolean
    sampling?: boolean
  }

  /**
   * Callback for each sample call (for assertions).
   */
  onSample?: (messages: Message[], options?: { systemPrompt?: string; maxTokens?: number }) => void

  /**
   * Callback for each elicit call (for assertions).
   */
  onElicit?: (config: ElicitConfig<any>) => void

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
 * Mock branch MCP client for testing.
 */
export interface MockBranchClient extends BranchMCPClient {
  /** Get all sample calls made */
  sampleCalls: Array<{
    messages: Message[]
    options?: { systemPrompt?: string; maxTokens?: number }
  }>

  /** Get all elicit calls made */
  elicitCalls: ElicitConfig<any>[]

  /** Get all log calls made */
  logCalls: Array<{ level: LogLevel; message: string }>

  /** Get all notify calls made */
  notifyCalls: Array<{ message: string; progress?: number }>

  /** Reset all call tracking */
  reset(): void
}

/**
 * Create a mock branch MCP client for testing.
 *
 * @example
 * ```typescript
 * const client = createMockBranchClient({
 *   sampleResponses: [
 *     'First response',
 *     { text: 'Second response', model: 'test-model' },
 *     (messages) => `Got ${messages.length} messages`,
 *   ],
 *   elicitResponses: [
 *     { action: 'accept', content: { choice: 'A' } },
 *   ],
 * })
 *
 * const result = yield* runBranchTool(myTool, { input: 'test' }, client)
 *
 * // Assert on calls made
 * expect(client.sampleCalls).toHaveLength(3)
 * expect(client.elicitCalls[0].message).toContain('Pick')
 * ```
 */
export function createMockBranchClient(
  config: MockBranchClientConfig = {}
): MockBranchClient {
  const sampleResponses = [...(config.sampleResponses ?? [])]
  const elicitResponses = [...(config.elicitResponses ?? [])]

  const capabilities = {
    elicitation: config.capabilities?.elicitation ?? true,
    sampling: config.capabilities?.sampling ?? true,
  }

  const sampleCalls: MockBranchClient['sampleCalls'] = []
  const elicitCalls: ElicitConfig<any>[] = []
  const logCalls: Array<{ level: LogLevel; message: string }> = []
  const notifyCalls: Array<{ message: string; progress?: number }> = []

  const client: MockBranchClient = {
    capabilities,

    sampleCalls,
    elicitCalls,
    logCalls,
    notifyCalls,

    reset() {
      sampleCalls.length = 0
      elicitCalls.length = 0
      logCalls.length = 0
      notifyCalls.length = 0
    },

    sample(
      messages: Message[],
      options?: { systemPrompt?: string; maxTokens?: number }
    ): Operation<SampleResult> {
      return {
        *[Symbol.iterator]() {
          if (!capabilities.sampling) {
            throw new MCPCapabilityError('sampling', 'Client does not support sampling')
          }

          // Store call with defined options only
          const callRecord: { messages: Message[]; options?: { systemPrompt?: string; maxTokens?: number } } = { messages }
          if (options !== undefined) {
            callRecord.options = options
          }
          sampleCalls.push(callRecord)
          config.onSample?.(messages, options)

          const response = sampleResponses.shift()
          if (response === undefined) {
            throw new Error('Mock branch client: No more sample responses configured')
          }

          // Extract the prompt text from the last user message for exchange construction
          const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
          const promptText = lastUserMsg?.content ?? ''

          // Handle different response types
          if (typeof response === 'function') {
            const result = response(messages)
            if (typeof result === 'string') {
              return { text: result, exchange: createRawSampleExchange(promptText, result) }
            }
            return result
          }
          if (typeof response === 'string') {
            return { text: response, exchange: createRawSampleExchange(promptText, response) }
          }
          return response
        },
      }
    },

    elicit<T>(elicitConfig: ElicitConfig<T>): Operation<ElicitResult<unknown, T>> {
      return {
        *[Symbol.iterator]() {
          if (!capabilities.elicitation) {
            throw new MCPCapabilityError('elicitation', 'Client does not support elicitation')
          }

          elicitCalls.push(elicitConfig)
          config.onElicit?.(elicitConfig)

          const rawResponse = elicitResponses.shift()
          if (!rawResponse) {
            throw new Error('Mock branch client: No more elicit responses configured')
          }

          // Construct mock exchange messages using MCP format
          const mockToolCallId = `mock_elicit_${Date.now()}`
          
          const requestMessage: McpMessage & { role: 'assistant' } = {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: mockToolCallId,
              name: '__elicit__',
              // Keep input empty; echo data in tool_result for history
              input: {},
            }],
          }

          const responseContent = rawResponse.action === 'accept'
            ? JSON.stringify(rawResponse.content)
            : JSON.stringify({ action: rawResponse.action })

          const responseMessage: McpMessage & { role: 'user' } = {
            role: 'user',
            content: [{
              type: 'tool_result',
              toolUseId: mockToolCallId,
              content: [{ type: 'text', text: responseContent }],
            }],
          }

          // Build mock exchange
          const mockExchange: ElicitExchange<unknown> = {
            context: undefined,
            request: requestMessage,
            response: responseMessage,
            messages: [requestMessage, responseMessage],
            withArguments: () => [requestMessage, responseMessage],
          }

          // Return ElicitResult with exchange
          if (rawResponse.action === 'accept') {
            return {
              action: 'accept',
              content: rawResponse.content,
              exchange: mockExchange,
            } as ElicitResult<unknown, T>
          } else if (rawResponse.action === 'decline') {
            return { action: 'decline' } as ElicitResult<unknown, T>
          } else {
            return { action: 'cancel' } as ElicitResult<unknown, T>
          }
        },
      }
    },

    log(level: LogLevel, message: string): Operation<void> {
      return {
        *[Symbol.iterator]() {
          logCalls.push({ level, message })
          config.onLog?.(level, message)
          return
        },
      }
    },

    notify(message: string, progress?: number): Operation<void> {
      return {
        *[Symbol.iterator]() {
          notifyCalls.push(progress !== undefined ? { message, progress } : { message })
          config.onNotify?.(message, progress)
          return
        },
      }
    },
  }

  return client
}

// =============================================================================
// CONVENIENCE RUNNER
// =============================================================================

/**
 * Execute a branch tool with a mock client (convenience wrapper).
 *
 * @example
 * ```typescript
 * const { result, client } = yield* runBranchToolMock(
 *   myTool,
 *   { input: 'test' },
 *   {
 *     sampleResponses: ['Response 1', 'Response 2'],
 *     elicitResponses: [{ action: 'accept', content: { ok: true } }],
 *   }
 * )
 *
 * expect(result).toBe('expected output')
 * expect(client.sampleCalls).toHaveLength(2)
 * ```
 */
export function runBranchToolMock<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
>(
  tool: FinalizedBranchTool<TName, TParams, THandoff, TClient, TResult>,
  params: TParams,
  mockConfig: MockBranchClientConfig = {},
  runOptions: RunBranchToolOptions = {}
): Operation<{ result: TResult; client: MockBranchClient }> {
  return {
    *[Symbol.iterator]() {
      const client = createMockBranchClient(mockConfig)
      const result = yield* runBranchTool(tool, params, client, runOptions)
      return { result, client }
    },
  }
}
