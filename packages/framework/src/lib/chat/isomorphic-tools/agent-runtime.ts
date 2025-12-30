/**
 * Agent Runtime
 *
 * Provides the infrastructure for running isomorphic tools as server-side agents.
 * An agent is a tool that runs on the server and can make LLM calls via ctx.prompt().
 *
 * ## Key Concepts
 *
 * 1. **Agent Context**: A ClientToolContext extended with `prompt()` for LLM calls
 * 2. **LLM Client**: Wraps a ChatProvider to provide structured output via `prompt()`
 * 3. **runAsAgent**: Executes a tool's `*client()` as an agent instead of in browser
 *
 * ## Usage
 *
 * ```typescript
 * import { runAsAgent, createAgentLLMClient } from './agent-runtime'
 *
 * // Create LLM client from your chat provider
 * const llm = createAgentLLMClient({ provider: openaiProvider })
 *
 * // Run a tool as an agent
 * const result = yield* runAsAgent({
 *   tool: myTool,
 *   handoffData: phase1.serverOutput,
 *   params,
 *   signal,
 *   llm,
 * })
 * ```
 */
import type { Operation, Stream, Subscription } from 'effection'
import type { z } from 'zod'
import type { AnyIsomorphicTool } from './types'
import { type AgentToolContext, type PromptOptions, type ApprovalResult, validateContextMode } from './contexts'
import type { ChatProvider, ChatStreamOptions } from '../providers/types'
import type { Message, ChatEvent, ChatResult } from '../types'

// --- LLM Client Types ---

/**
 * An LLM client that can execute structured prompts.
 *
 * This is injected into AgentToolContext to provide `ctx.prompt()`.
 */
export interface AgentLLMClient {
  /**
   * Execute a one-shot structured prompt.
   *
   * Uses the provider's streaming API internally, accumulates the response,
   * parses it as JSON, and validates against the schema.
   */
  prompt<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>>
}

/**
 * Options for creating an LLM client.
 */
export interface CreateAgentLLMClientOptions {
  /** The chat provider to use (e.g., openaiProvider) */
  provider: ChatProvider

  /** Default model to use if not specified in prompt options */
  defaultModel?: string

  /** Default system prompt if not specified in prompt options */
  defaultSystem?: string

  /** Options passed to the provider's stream() method */
  streamOptions?: Partial<ChatStreamOptions>
}

// --- LLM Client Implementation ---

/**
 * Create an LLM client for agent execution.
 *
 * Wraps a ChatProvider to provide structured output via Zod schemas.
 * Uses the provider's streaming API and accumulates the response.
 */
export function createAgentLLMClient(options: CreateAgentLLMClientOptions): AgentLLMClient {
  const { provider, defaultModel, defaultSystem, streamOptions } = options

  return {
    *prompt<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>> {
      const messages: Message[] = []

      // Add system message if provided
      const system = opts.system ?? defaultSystem
      if (system) {
        messages.push({ role: 'system', content: system })
      }

      // Add user message with the prompt
      messages.push({ role: 'user', content: opts.prompt })

      // Create stream options with model override
      const model = opts.model ?? defaultModel ?? streamOptions?.model
      const finalOptions: ChatStreamOptions = {
        ...streamOptions,
        ...(model ? { model } : {}),
      }

      // Stream the response and accumulate text
      const stream: Stream<ChatEvent, ChatResult> = provider.stream(messages, finalOptions)
      const subscription: Subscription<ChatEvent, ChatResult> = yield* stream

      let textBuffer = ''

      // Consume the stream
      let next = yield* subscription.next()
      while (!next.done) {
        const event = next.value
        if (event.type === 'text') {
          textBuffer += event.content
        }
        next = yield* subscription.next()
      }

      // Parse JSON from accumulated text
      let parsed: unknown
      try {
        parsed = JSON.parse(textBuffer)
      } catch (e) {
        throw new Error(
          `Failed to parse LLM response as JSON: ${e instanceof Error ? e.message : String(e)}\n` +
          `Raw response: ${textBuffer.slice(0, 500)}${textBuffer.length > 500 ? '...' : ''}`
        )
      }

      // Validate against schema
      const validated = opts.schema.safeParse(parsed)
      if (!validated.success) {
        throw new Error(
          `LLM response failed schema validation: ${validated.error.message}\n` +
          `Raw response: ${textBuffer.slice(0, 500)}${textBuffer.length > 500 ? '...' : ''}`
        )
      }

      return validated.data
    },
  }
}

// --- Agent Execution ---

/**
 * Options for running a tool as an agent.
 */
export interface RunAsAgentOptions {
  /** The isomorphic tool to execute */
  tool: AnyIsomorphicTool

  /** Handoff data from phase 1 (passed to tool.client()) */
  handoffData: unknown

  /** Original params from the LLM (passed to tool.client()) */
  params: unknown

  /** Abort signal for cancellation */
  signal: AbortSignal

  /** LLM client for ctx.prompt() */
  llm: AgentLLMClient

  /** Optional event handler for ctx.emit() */
  onEmit?: (event: unknown) => Operation<void>

  /** Optional custom callId (defaults to generated UUID) */
  callId?: string
}

/**
 * Run a tool's `*client()` as a server-side agent.
 *
 * Instead of running in a browser with UI interactions (waitFor),
 * the tool runs on the server with LLM capabilities (prompt).
 *
 * This enables:
 * - Sequential LLM calls within a tool
 * - Parallel LLM calls with spawn() + all()
 * - Nested agent composition (agents calling agents)
 * - Streaming events to parent via emit()
 *
 * @example
 * ```typescript
 * // Run phase 1 to get handoff data
 * const phase1 = yield* executeServerPart(tool, callId, params, signal)
 * if (phase1.kind !== 'handoff') { ... }
 *
 * // Run as agent instead of browser
 * const clientResult = yield* runAsAgent({
 *   tool,
 *   handoffData: phase1.serverOutput,
 *   params,
 *   signal,
 *   llm: createAgentLLMClient({ provider: openaiProvider }),
 * })
 *
 * // Complete phase 2 with agent's result
 * const result = yield* executeServerPhase2(
 *   tool, callId, params, clientResult, phase1.serverOutput, signal, true
 * )
 * ```
 */
export function* runAsAgent(options: RunAsAgentOptions): Operation<unknown> {
  const { tool, handoffData, params, signal, llm, onEmit, callId } = options

  if (!tool.client) {
    throw new Error(`Tool "${tool.name}" has no client function to run as agent`)
  }

  // Validate that the tool can run in agent context
  // Tools with 'headless' context can run anywhere (including as agent)
  // Tools with 'agent' context require agent environment
  // Tools with 'browser' context cannot run as agent
  const toolContext = tool.contextMode ?? 'headless' // Legacy tools default to headless
  validateContextMode(tool.name, toolContext, 'agent')

  // Generate a callId if not provided
  const effectiveCallId = callId ?? `agent-${crypto.randomUUID()}`

  // Create the agent context
  const ctx: AgentToolContext = {
    callId: effectiveCallId,
    signal,

    // Approval always granted for agents (they're automated)
    requestApproval(_message: string): Operation<ApprovalResult> {
      return function* () {
        return { approved: true }
      }()
    },

    requestPermission(_type: string): Operation<ApprovalResult> {
      return function* () {
        return { approved: true }
      }()
    },

    reportProgress(_message: string): Operation<void> {
      return function* () {
        // Could emit as an event if onEmit is provided
        if (onEmit) {
          yield* onEmit({ type: 'progress', message: _message })
        }
      }()
    },

    // The core agent capability - LLM calls
    prompt: llm.prompt.bind(llm),

    // Optional event emission
    emit: onEmit,
  }

  // Execute the tool's client function with agent context
  return yield* tool.client(handoffData, ctx, params)
}

// --- Mock Agent Context (for testing) ---

/**
 * Options for creating a mock agent context.
 */
export interface CreateMockAgentToolContextOptions {
  /** Unique call ID */
  callId: string

  /** Abort signal */
  signal?: AbortSignal

  /**
   * Mock LLM responses.
   * Key is a substring to match in the prompt, value is the response.
   */
  llmResponses?: Map<string, unknown>

  /** Handler for emitted events */
  onEmit?: (event: unknown) => void
}

/**
 * Create a mock agent context for testing.
 *
 * The mock `prompt()` looks up responses by matching substrings in the prompt.
 *
 * @example
 * ```typescript
 * const llmResponses = new Map([
 *   ['analyze', { findings: ['Finding 1'] }],
 *   ['summarize', { summary: 'Brief summary' }],
 * ])
 *
 * const ctx = createMockAgentToolContext({
 *   callId: 'test-1',
 *   llmResponses,
 * })
 *
 * const result = yield* tool.client!(handoffData, ctx, params)
 * ```
 */
export function createMockAgentToolContext(options: CreateMockAgentToolContextOptions): AgentToolContext {
  const {
    callId,
    signal = new AbortController().signal,
    llmResponses = new Map(),
    onEmit,
  } = options

  const emittedEvents: unknown[] = []

  return {
    callId,
    signal,

    requestApproval(_message: string): Operation<ApprovalResult> {
      return function* () {
        return { approved: true }
      }()
    },

    requestPermission(_type: string): Operation<ApprovalResult> {
      return function* () {
        return { approved: true }
      }()
    },

    reportProgress(_message: string): Operation<void> {
      return function* () {}()
    },

    prompt<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>> {
      return function* () {
        // Find response by matching prompt substring
        for (const [key, value] of llmResponses) {
          if (opts.prompt.includes(key)) {
            // Validate against schema
            const validated = opts.schema.safeParse(value)
            if (!validated.success) {
              throw new Error(
                `Mock LLM response failed schema validation: ${validated.error.message}`
              )
            }
            return validated.data
          }
        }
        throw new Error(`No mock LLM response for prompt: ${opts.prompt.slice(0, 100)}...`)
      }()
    },

    emit: onEmit
      ? (event: unknown) =>
          function* () {
            emittedEvents.push(event)
            onEmit(event)
          }()
      : undefined,
  }
}

/**
 * Create a mock agent context with a simple response function.
 *
 * More flexible than the Map-based version for complex testing scenarios.
 */
export function createMockAgentToolContextWithResponder(options: {
  callId: string
  signal?: AbortSignal
  respond: <T extends z.ZodType>(opts: PromptOptions<T>) => z.infer<T>
  onEmit?: (event: unknown) => void
}): AgentToolContext {
  const { callId, signal = new AbortController().signal, respond, onEmit } = options

  return {
    callId,
    signal,

    requestApproval(): Operation<ApprovalResult> {
      return function* () {
        return { approved: true }
      }()
    },

    requestPermission(): Operation<ApprovalResult> {
      return function* () {
        return { approved: true }
      }()
    },

    reportProgress(): Operation<void> {
      return function* () {}()
    },

    prompt<T extends z.ZodType>(opts: PromptOptions<T>): Operation<z.infer<T>> {
      return function* () {
        const response = respond(opts)
        const validated = opts.schema.safeParse(response)
        if (!validated.success) {
          throw new Error(
            `Mock responder returned invalid data: ${validated.error.message}`
          )
        }
        return validated.data
      }()
    },

    emit: onEmit
      ? (event: unknown) =>
          function* () {
            onEmit(event)
          }()
      : undefined,
  }
}
