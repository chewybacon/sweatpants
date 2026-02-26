/**
 * Client-side execution for isomorphic tools.
 */
import type { Operation, Channel, Signal } from 'effection'
import { useAbortSignal, each, all } from 'effection'
import type {
  AnyIsomorphicTool,
  IsomorphicToolResult,
  IsomorphicHandoffEvent,
} from './types.ts'
import type { ChatPatch } from './runtime/types.ts'
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

export function* executeClientPart(
  tool: AnyIsomorphicTool,
  handoff: IsomorphicHandoffEvent,
  patches: Channel<ChatPatch, void>,
  approvalSignal: Signal<ApprovalSignalValue, void>,
  uiRequestChannel?: Channel<PendingUIRequest, void>,
  emissionChannel?: Channel<PendingEmission, void>
): Operation<IsomorphicToolResult> {
  const abortSignal = yield* useAbortSignal()
  const { callId, params, serverOutput } = handoff

  yield* patches.send({
    type: 'isomorphic_tool_state',
    id: callId,
    state: 'awaiting_client_approval',
    serverOutput,
  } as ChatPatch)

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

  yield* patches.send({
    type: 'isomorphic_tool_state',
    id: callId,
    state: 'client_executing',
    serverOutput,
  } as ChatPatch)

  if (!tool.client) {
    throw new Error(`Isomorphic tool "${tool.name}" has no client function`)
  }

  const baseContext = createClientContext(
    callId,
    abortSignal,
    patches,
    approvalSignal,
    tool.name,
    uiRequestChannel
  )

  let executionContext: BaseToolContext | BrowserRenderContext = baseContext

  if (emissionChannel) {
    const runtimeConfig: RuntimeConfig = {
      handlers: {
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

    yield* patches.send({
      type: 'tool_emission_start',
      callId,
      toolName: tool.name,
    } as ChatPatch)
  }

  try {
    const clientOutput = yield* tool.client(serverOutput, executionContext, params)
    const content = typeof serverOutput === 'string' ? serverOutput : JSON.stringify(serverOutput)

    yield* patches.send({
      type: 'isomorphic_tool_state',
      id: callId,
      state: 'complete',
      serverOutput,
      clientOutput,
    } as ChatPatch)

    yield* patches.send({
      type: 'client_tool_complete',
      id: callId,
      result: content,
    })

    yield* patches.send({
      type: 'tool_call_result',
      id: callId,
      result: content,
    })

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

function createClientContext(
  callId: string,
  signal: AbortSignal,
  patches: Channel<ChatPatch, void>,
  approvalSignal: Signal<ApprovalSignalValue, void>,
  toolName: string,
  uiRequestChannel?: Channel<PendingUIRequest, void>
): BaseToolContext | BrowserToolContext {
  const waitForContext = uiRequestChannel ? createWaitForContext(callId, uiRequestChannel) : undefined

  const baseCtx: BaseToolContext = {
    callId,
    signal,

    requestApproval(message: string): Operation<ApprovalResult> {
      return function* () {
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
      return function* () {
        yield* patches.send({
          type: 'client_tool_permission_request',
          id: callId,
          permissionType: type,
        })
        return yield* waitForApproval(callId, approvalSignal)
      }()
    },

    reportProgress(message: string): Operation<void> {
      return function* () {
        yield* patches.send({
          type: 'client_tool_progress',
          id: callId,
          message,
        })
      }()
    },
  }

  if (waitForContext) {
    return {
      ...baseCtx,
      waitFor: waitForContext.waitFor.bind(waitForContext),
    }
  }

  return baseCtx
}

function* waitForApproval(
  callId: string,
  approvalSignal: Signal<ApprovalSignalValue, void>
): Operation<ApprovalResult> {
  for (const value of yield* each(approvalSignal)) {
    if (value.callId === callId) {
      if (value.approved) {
        return { approved: true }
      } else {
        return value.reason ? { approved: false, reason: value.reason } : { approved: false }
      }
    }
    yield* each.next()
  }
  return { approved: false, reason: 'Approval cancelled' }
}

function getApprovalMessage(tool: AnyIsomorphicTool, params: unknown): string {
  const message = tool.approval?.clientMessage
  if (typeof message === 'function') {
    return message(params)
  }
  if (typeof message === 'string') {
    return message
  }
  return `Allow "${tool.name}" to execute?`
}
