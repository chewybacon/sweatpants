/**
 * Isomorphic Tool Executor
 *
 * Handles execution of isomorphic tools based on their authority mode.
 *
 * KEY PRINCIPLE: Server's return value is ALWAYS the final result to the LLM.
 *
 * ## CLIENT AUTHORITY (e.g., ask_question)
 * 1. LLM calls tool → Server receives call
 * 2. Server immediately sends handoff to client (no server code yet)
 * 3. Client executes tool.client(params) → returns clientOutput
 * 4. Client RE-INITIATES chat with clientOutput
 * 5. Server receives re-initiation → calls tool.server(params, ctx, clientOutput)
 * 6. Server's return value goes to LLM
 *
 * ## SERVER AUTHORITY - Simple (e.g., celebrate)
 * 1. LLM calls tool → Server receives call
 * 2. Server executes tool.server(params) → returns serverOutput
 * 3. Server sends handoff to client with serverOutput
 * 4. Client executes tool.client(serverOutput) for side effects (UI, etc.)
 * 5. Client RE-INITIATES chat (server result is already determined)
 * 6. Server's original return value goes to LLM
 *
 * ## SERVER AUTHORITY - With Handoff (V7 Pattern)
 * 1. LLM calls tool → Server receives call
 * 2. Server executes tool.server(params, ctx) in PHASE 1
 *    - ctx.handoff({ before, after }) runs before(), halts at handoff point
 *    - Handoff data sent to client
 * 3. Client executes tool.client(handoffData) → returns clientOutput
 * 4. Client RE-INITIATES chat with clientOutput
 * 5. Server executes tool.server(params, ctx) in PHASE 2
 *    - ctx.handoff() skips before(), runs after(handoff, clientOutput)
 * 6. Server's after() return value goes to LLM
 *
 * ## PARALLEL
 * 1. Server and client execute concurrently
 * 2. Server's return value goes to LLM
 * 3. Client execution is for side effects only
 */
import type { Operation, Channel, Signal } from 'effection'
import { useAbortSignal, each, all } from 'effection'
import type {
  AnyIsomorphicTool,
  IsomorphicToolResult,
  ServerToolContext,
  ServerAuthorityContext,
  IsomorphicHandoffEvent,
  HandoffConfig,
} from './types.ts'
import { HandoffReadyError } from './types.ts'
import { validateToolParams } from '../utils.ts'
import type {
  ChatPatch,
  AuthorityMode,
} from './runtime/types.ts'
import type { ApprovalSignalValue } from './runtime/tool-runtime.ts'
import type { BaseToolContext, BrowserToolContext, ApprovalResult, PermissionType } from './contexts.ts'
import {
  createWaitForContext,
  type PendingUIRequest,
} from './ui-requests.ts'
import {
  createRuntime,
  type PendingEmission,
  type RuntimeConfig,
  COMPONENT_EMISSION_TYPE,
} from './runtime/emissions.ts'
import {
  createBrowserContext,
  type BrowserRenderContext,
} from './runtime/browser-context.ts'

// Re-export AuthorityMode for internal use
export type { AuthorityMode }

// --- Phase 1 Server Executor (for handoff tools) ---




/**
 * Create a phase 1 context that halts at handoff.
 *
 * In phase 1, ctx.handoff():
 * - Runs before() to compute handoff data
 * - Throws HandoffReadyError to halt execution
 */
function createPhase1Context(
  baseContext: ServerToolContext
): ServerAuthorityContext {
  return {
    ...baseContext,
    *handoff<THandoff, TClient, TResult>(config: HandoffConfig<THandoff, TClient, TResult>) {
      const handoffData = yield* config.before()
      throw new HandoffReadyError(handoffData)
    },
  }
}

/**
 * Create a phase 2 context that skips before() and runs after().
 *
 * In phase 2, ctx.handoff():
 * - Skips before() entirely
 * - Runs after() with cached handoff data + client output
 */
function createPhase2Context(
  baseContext: ServerToolContext,
  cachedHandoff: unknown,
  clientOutput: unknown
): ServerAuthorityContext {
  return {
    ...baseContext,
    *handoff<THandoff, TClient, TResult>(config: HandoffConfig<THandoff, TClient, TResult>) {
      return yield* config.after(cachedHandoff as THandoff, clientOutput as TClient)
    },
  }
}

// --- Server-Side Executor ---

/**
 * Execute the server portion of an isomorphic tool (PHASE 1).
 *
 * For `client` authority: Returns immediate handoff (no server code yet).
 * For `server` authority: Executes server code, may halt at handoff point.

 *
 * @returns The handoff event to send to client, plus serverOutput if available
 */
export function* executeServerPart(
  tool: AnyIsomorphicTool,
  callId: string,
  params: unknown,
  signal: AbortSignal
): Operation<
  | {
    kind: 'handoff'
    handoff: IsomorphicHandoffEvent
    serverOutput?: unknown
    /** True if the tool uses ctx.handoff() and needs phase 2 */
    usesHandoff: boolean
  }
  | {
    kind: 'result'
    serverOutput: unknown
  }
> {
  const baseContext: ServerToolContext = {
    callId,
    signal,
  }

  const authority = tool.authority ?? 'server'

  const validatedParams = validateToolParams(tool, params)

  // For client authority, we don't execute server code yet
  // Client runs first, then server validates after re-initiation
  if (authority === 'client') {
    return {
      kind: 'handoff',
      handoff: {
        type: 'isomorphic_handoff',
        callId,
        toolName: tool.name,
        params: validatedParams,
        serverOutput: undefined,
        authority,
        usesHandoff: false,
      },
      serverOutput: undefined,
      usesHandoff: false,
    }
  }

  // For server authority, execute server code now
  if (!tool.server) {
    throw new Error(`Isomorphic tool "${tool.name}" has ${authority} authority but no server function`)
  }

  // Create phase 1 context with handoff capability
  const phase1Context = createPhase1Context(baseContext)

  try {
    // Try to run the server operation
    const serverOutput = yield* tool.server(validatedParams, phase1Context)


    // If we get here, the tool completed without calling handoff().
    // If the tool has a client() function, we must hand off for side effects.
    // Otherwise, this is a true server-only tool and we can return the result directly.
    if (!tool.client) {
      return {
        kind: 'result',
        serverOutput,
      }
    }

    return {
      kind: 'handoff',
      handoff: {
        type: 'isomorphic_handoff',
        callId,
        toolName: tool.name,
        params: validatedParams,
        serverOutput,
        authority,
        usesHandoff: false,
      },
      serverOutput,
      usesHandoff: false,
    }

  } catch (e) {
    if (e instanceof HandoffReadyError) {
      // Tool called handoff() - we halted at the handoff point
      return {
        kind: 'handoff',
        handoff: {
          type: 'isomorphic_handoff',
          callId,
          toolName: tool.name,
          params: validatedParams,
          serverOutput: e.handoffData,
          authority,
          usesHandoff: true,
        },
        serverOutput: e.handoffData,
        usesHandoff: true,
      }

    }
    // Re-throw other errors
    throw e
  }
}

/**
 * Complete the server portion after client returns (PHASE 2 for handoff tools).
 *
 * Called when the client re-initiates after executing its part.
 *
 * For client authority: Runs the server function with clientOutput.
 * For server authority with handoff: Re-runs server function in phase 2 mode.
 * For server authority without handoff: Just returns the cached serverOutput.
 *
 * The return value of this function is what the LLM sees as the tool result.
 */
export function* executeServerPhase2(
  tool: AnyIsomorphicTool,
  callId: string,
  params: unknown,
  clientOutput: unknown,
  cachedHandoff: unknown,
  signal: AbortSignal,
  usesHandoff: boolean
): Operation<unknown> {
  const authority = tool.authority ?? 'server'

  const validatedParams = validateToolParams(tool, params)

  // For client authority, run the server function with clientOutput
  if (authority === 'client') {
    if (!tool.server) {
      throw new Error(`Isomorphic tool "${tool.name}" has client authority but no server function`)
    }

    const context: ServerToolContext = {
      callId,
      signal,
    }

    return yield* tool.server(validatedParams, context, clientOutput)
  }

  // For server authority without handoff, just return cached output
  if (!usesHandoff) {
    return cachedHandoff
  }

  // For server authority with handoff, run phase 2
  if (!tool.server) {
    throw new Error(`Isomorphic tool "${tool.name}" has server authority but no server function`)
  }

  const baseContext: ServerToolContext = {
    callId,
    signal,
  }

  const phase2Context = createPhase2Context(baseContext, cachedHandoff, clientOutput)

  return yield* tool.server(validatedParams, phase2Context)
}

/**
 * Complete the server portion after client returns (for client authority).
 *
 * @deprecated Use executeServerPhase2 instead.
 */
export function* executeServerValidation(
  tool: AnyIsomorphicTool,
  callId: string,
  params: unknown,
  clientOutput: unknown,
  signal: AbortSignal
): Operation<unknown> {
  return yield* executeServerPhase2(
    tool,
    callId,
    params,
    clientOutput,
    undefined, // No cached handoff for client authority
    signal,
    false // Client authority doesn't use handoff pattern
  )
}

// --- Client-Side Executor ---

/**
 * Execute the client portion of an isomorphic tool.
 *
 * Called after receiving a handoff event from the server.
 *
 * For client authority: Returns clientOutput (to be sent back to server)
 * For server authority: Client execution is for side effects, serverOutput already determined
 *
 * The result.content for server authority IS the serverOutput (already determined).
 * The result.content for client authority is a placeholder until server validates.
 *
 * @param tool - The isomorphic tool to execute
 * @param handoff - The handoff event from the server
 * @param patches - Channel to emit patches
 * @param approvalSignal - Signal for approval from React UI
 * @param uiRequestChannel - Optional channel for waitFor UI requests
 * @param emissionChannel - Optional channel for emissions (ctx.render pattern)
 */
export function* executeClientPart(
  tool: AnyIsomorphicTool,
  handoff: IsomorphicHandoffEvent,
  patches: Channel<ChatPatch, void>,
  approvalSignal: Signal<ApprovalSignalValue, void>,
  uiRequestChannel?: Channel<PendingUIRequest, void>,
  emissionChannel?: Channel<PendingEmission, void>
): Operation<IsomorphicToolResult> {
  const abortSignal = yield* useAbortSignal()
  const { callId, params, serverOutput, authority } = handoff

  // Emit initial state
  yield* patches.send({
    type: 'isomorphic_tool_state',
    id: callId,
    state: 'awaiting_client_approval',
    authority,
    serverOutput,
  } as ChatPatch)

  // Check if client approval is needed
  const clientApproval = tool.approval?.client ?? 'confirm'

  if (clientApproval !== 'none') {
    const approvalMessage = getApprovalMessage(tool, params)

    yield* patches.send({
      type: 'client_tool_awaiting_approval',
      id: callId,
      name: tool.name,
      message: approvalMessage,
    })

    const approval = yield* waitForApproval(callId, approvalSignal)

    if (!approval.approved) {
      const reason = approval.reason ?? 'User denied'

      yield* patches.send({
        type: 'client_tool_denied',
        id: callId,
        reason,
      })

      return {
        callId,
        toolName: tool.name,
        ok: false,
        error: reason,
      }
    }
  }

  // Execute client code
  yield* patches.send({
    type: 'isomorphic_tool_state',
    id: callId,
    state: 'client_executing',
    authority,
    serverOutput,
  } as ChatPatch)

  if (!tool.client) {
    throw new Error(`Isomorphic tool "${tool.name}" has no client function`)
  }

  // Create base client context with optional waitFor support
  const baseContext = createClientContext(
    callId,
    abortSignal,
    patches,
    approvalSignal,
    tool.name,
    uiRequestChannel
  )

  // If emission channel is provided, create browser context with render() support
  let executionContext: BaseToolContext | BrowserRenderContext = baseContext

  if (emissionChannel) {
    // Create runtime with emission channel for React integration
    const runtimeConfig: RuntimeConfig = {
      handlers: {
        // Component emissions are handled via the channel, not inline handlers
        [COMPONENT_EMISSION_TYPE]: () => {
          // No-op - response comes from channel consumer
        },
      },
      emissionChannel,
      fallback: 'error',
    }

    const runtime = createRuntime(runtimeConfig, callId)

    executionContext = createBrowserContext({
      runtime,
      callId,
      toolName: tool.name,
      baseContext,
      signal: abortSignal,
    })

    // Emit tool_emission_start patch so UI knows an emission-enabled tool is running
    yield* patches.send({
      type: 'tool_emission_start',
      callId,
      toolName: tool.name,
    } as ChatPatch)
  }

  try {
    // Determine what to pass to client based on authority
    const clientInput = authority === 'server' ? serverOutput : params
    const clientOutput = yield* tool.client(clientInput, executionContext, params)

    // Determine the result based on authority
    let content: string

    if (authority === 'server') {
      // Server already ran - serverOutput is the final result
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      content = typeof serverOutput === 'string'
        ? serverOutput
        : JSON.stringify(serverOutput)
    } else {
      // Client authority - we need to return clientOutput for the session
      // to re-initiate with. The actual LLM result comes from server validation.
      // For now, we serialize clientOutput as a placeholder.
      content = typeof clientOutput === 'string'
        ? clientOutput
        : JSON.stringify(clientOutput)
    }

    // Emit completion
    yield* patches.send({
      type: 'isomorphic_tool_state',
      id: callId,
      state: authority === 'client' ? 'server_validating' : 'complete',
      authority,
      serverOutput,
      clientOutput,
    } as ChatPatch)

    yield* patches.send({
      type: 'client_tool_complete',
      id: callId,
      result: content,
    })

    // For client authority, the session will use clientOutput to re-initiate
    // and get the real result from server validation.
    // For server authority, this is the final result.
    if (authority === 'server') {
      yield* patches.send({
        type: 'tool_call_result',
        id: callId,
        result: content,
      })
    }

    return {
      callId,
      toolName: tool.name,
      ok: true,
      content,
      serverOutput,
      clientOutput,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    yield* patches.send({
      type: 'isomorphic_tool_state',
      id: callId,
      state: 'error',
      authority,
      error: errorMessage,
    } as ChatPatch)

    yield* patches.send({
      type: 'client_tool_error',
      id: callId,
      error: errorMessage,
    })

    yield* patches.send({
      type: 'tool_call_error',
      id: callId,
      error: errorMessage,
    })

    return {
      callId,
      toolName: tool.name,
      ok: false,
      error: errorMessage,
    }
  }
}

// --- Context Helpers ---

/**
 * Create a client execution context.
 *
 * @param callId - The tool call ID
 * @param signal - Abort signal for cancellation
 * @param patches - Channel to emit patches
 * @param approvalSignal - Signal for approval from React UI
 * @param toolName - Name of the tool being executed
 * @param uiRequestChannel - Optional channel for waitFor UI requests
 */
function createClientContext(
  callId: string,
  signal: AbortSignal,
  patches: Channel<ChatPatch, void>,
  approvalSignal: Signal<ApprovalSignalValue, void>,
  toolName: string,
  uiRequestChannel?: Channel<PendingUIRequest, void>
): BaseToolContext | BrowserToolContext {
  // Create waitFor context if channel is provided
  const waitForContext = uiRequestChannel
    ? createWaitForContext(callId, uiRequestChannel)
    : undefined

  const baseCtx: BaseToolContext = {
    callId,
    signal,

    requestApproval(message: string): Operation<ApprovalResult> {
      return function*() {
        yield* patches.send({
          type: 'client_tool_awaiting_approval',
          id: callId,
          name: toolName,
          message,
        })
        return yield* waitForApproval(callId, approvalSignal)
      }()
    },

    requestPermission(type: PermissionType): Operation<ApprovalResult> {
      return function*() {
        yield* patches.send({
          type: 'client_tool_permission_request',
          id: callId,
          permissionType: type,
        })
        return yield* waitForApproval(callId, approvalSignal)
      }()
    },

    reportProgress(message: string): Operation<void> {
      return function*() {
        yield* patches.send({
          type: 'client_tool_progress',
          id: callId,
          message,
        })
      }()
    },
  }

  // If waitFor is available, return BrowserToolContext
  if (waitForContext) {
    const browserCtx: BrowserToolContext = {
      ...baseCtx,
      waitFor: waitForContext.waitFor.bind(waitForContext),
    }
    return browserCtx
  }

  return baseCtx
}

// --- Approval Helpers ---

/**
 * Wait for approval signal for a specific tool call.
 */
function* waitForApproval(
  callId: string,
  approvalSignal: Signal<ApprovalSignalValue, void>
): Operation<ApprovalResult> {
  for (const value of yield* each(approvalSignal)) {
    if (value.callId === callId) {
      if (value.approved) {
        return { approved: true }
      } else {
        return value.reason
          ? { approved: false, reason: value.reason }
          : { approved: false }
      }
    }
    yield* each.next()
  }
  return { approved: false, reason: 'Approval cancelled' }
}

/**
 * Get the approval message for a tool.
 */
function getApprovalMessage(
  tool: AnyIsomorphicTool,
  params: unknown
): string {
  const message = tool.approval?.clientMessage
  if (typeof message === 'function') {
    return message(params)
  }
  if (typeof message === 'string') {
    return message
  }
  return `Allow "${tool.name}" to execute?`
}

// --- Batch Client Executor ---

/**
 * Execute multiple isomorphic tools concurrently on the client.
 *
 * @param handoffs - The tool handoffs to execute
 * @param patches - Channel to emit patches
 * @param approvalSignal - Signal for approval from React UI
 * @param uiRequestChannel - Optional channel for waitFor UI requests
 * @param emissionChannel - Optional channel for emissions (ctx.render pattern)
 */
export function* executeIsomorphicToolsClient(
  handoffs: Array<{ tool: AnyIsomorphicTool; handoff: IsomorphicHandoffEvent }>,
  patches: Channel<ChatPatch, void>,
  approvalSignal: Signal<ApprovalSignalValue, void>,
  uiRequestChannel?: Channel<PendingUIRequest, void>,
  emissionChannel?: Channel<PendingEmission, void>
): Operation<IsomorphicToolResult[]> {
  return yield* all(
    handoffs.map(({ tool, handoff }) =>
      executeClientPart(tool, handoff, patches, approvalSignal, uiRequestChannel, emissionChannel)
    )
  )
}

// --- React Handler Support ---

/**
 * Options for executing isomorphic tools with React handler support.
 */
export interface ReactHandlerExecutionOptions {
  /** The tool handoffs to execute */
  handoffs: Array<{ tool: AnyIsomorphicTool; handoff: IsomorphicHandoffEvent }>
  /** Channel to emit patches */
  patches: Channel<ChatPatch, void>
  /** Signal for approval from React UI */
  approvalSignal: Signal<ApprovalSignalValue, void>
  /**
   * Registry of React handlers.
   * Tools with handlers here use React UI instead of *client() generator.
   */
  reactHandlers?: {
    has(toolName: string): boolean
  }
  /**
   * Signal to receive responses from React handlers.
   * Required if reactHandlers is provided.
   */
  handoffResponseSignal?: Signal<{ callId: string; output: unknown }, void>
  /**
   * Channel for UI requests from tools using ctx.waitFor().
   * Tools can yield* ctx.waitFor('type', payload) to suspend and wait for UI input.
   */
  uiRequestChannel?: Channel<PendingUIRequest, void>
  /**
   * Channel for emissions (ctx.render pattern).
   * When provided, tools can use ctx.render() to render React components.
   */
  emissionChannel?: Channel<PendingEmission, void>
}

/**
 * Execute a single tool via React handler mode.
 *
 * Emits a pending_handoff patch and waits for response signal.
 */
function* executeViaReactHandler(
  tool: AnyIsomorphicTool,
  handoff: IsomorphicHandoffEvent,
  patches: Channel<ChatPatch, void>,
  handoffResponseSignal: Signal<{ callId: string; output: unknown }, void>
): Operation<IsomorphicToolResult> {
  const { callId, params, serverOutput, authority } = handoff

  // Determine what data the React handler receives
  // Same logic as in executeClientPart
  const handoffData = authority === 'server' ? serverOutput : params

  // Emit pending_handoff patch for React to render UI
  yield* patches.send({
    type: 'pending_handoff',
    handoff: {
      callId,
      toolName: tool.name,
      params,
      data: handoffData,
      authority,
      usesHandoff: handoff.usesHandoff ?? false,
    },
  } as ChatPatch)

  // Wait for React to respond via the signal
  let clientOutput: unknown
  for (const response of yield* each(handoffResponseSignal)) {
    if (response.callId === callId) {
      clientOutput = response.output
      break
    }
    yield* each.next()
  }

  // Emit handoff_complete to remove from pending state
  yield* patches.send({
    type: 'handoff_complete',
    callId,
  } as ChatPatch)

  // Build the result
  // For server authority, serverOutput is already the final result
  // For client authority, clientOutput will be validated by server
  const content = authority === 'server'
    ? (typeof serverOutput === 'string' ? serverOutput : JSON.stringify(serverOutput))
    : (typeof clientOutput === 'string' ? clientOutput : JSON.stringify(clientOutput))

  // Emit completion patches
  yield* patches.send({
    type: 'isomorphic_tool_state',
    id: callId,
    state: authority === 'client' ? 'server_validating' : 'complete',
    authority,
    serverOutput,
    clientOutput,
  } as ChatPatch)

  yield* patches.send({
    type: 'client_tool_complete',
    id: callId,
    result: content,
  })

  if (authority === 'server') {
    yield* patches.send({
      type: 'tool_call_result',
      id: callId,
      result: content,
    })
  }

  return {
    callId,
    toolName: tool.name,
    ok: true,
    content,
    serverOutput,
    clientOutput,
  }
}

/**
 * Execute multiple isomorphic tools with React handler support.
 *
 * Tools with registered React handlers will use the React UI pattern:
 * 1. Emit pending_handoff patch
 * 2. Wait for handoffResponseSignal
 * 3. Continue with response as clientOutput
 *
 * Tools without React handlers use their *client() generator as normal.
 * If uiRequestChannel is provided, tools can use ctx.waitFor() for UI input.
 */
export function* executeIsomorphicToolsClientWithReactHandlers(
  options: ReactHandlerExecutionOptions
): Operation<IsomorphicToolResult[]> {
  const { handoffs, patches, approvalSignal, reactHandlers, handoffResponseSignal, uiRequestChannel, emissionChannel } = options

  return yield* all(
    handoffs.map(({ tool, handoff }) => {
      // Check if this tool has a React handler
      if (reactHandlers?.has(tool.name) && handoffResponseSignal) {
        return executeViaReactHandler(tool, handoff, patches, handoffResponseSignal)
      }
      // Fall back to normal *client() execution with optional waitFor and emission support
      return executeClientPart(tool, handoff, patches, approvalSignal, uiRequestChannel, emissionChannel)
    })
  )
}

// --- Tool Result Message Formatting ---

/**
 * Format isomorphic tool result for LLM re-initiation.
 */
export function formatIsomorphicToolResult(
  result: IsomorphicToolResult
): { role: 'tool'; tool_call_id: string; content: string } {
  return {
    role: 'tool',
    tool_call_id: result.callId,
    content: result.ok ? result.content! : `Error: ${result.error}`,
  }
}
