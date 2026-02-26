/**
 * React handler execution for isomorphic tools.
 */
import type { Operation, Channel, Signal } from 'effection'
import { each, all } from 'effection'
import type {
  AnyIsomorphicTool,
  IsomorphicToolResult,
  IsomorphicHandoffEvent,
} from './types.ts'
import type { ChatPatch } from './runtime/types.ts'
import type { ApprovalSignalValue } from './runtime/tool-runtime.ts'
import type { PendingUIRequest } from './ui-requests.ts'
import type { PendingEmission } from './runtime/emissions.ts'
import { executeClientPart } from './client-executor.ts'

export interface ReactHandlerExecutionOptions {
  handoffs: Array<{ tool: AnyIsomorphicTool; handoff: IsomorphicHandoffEvent }>
  patches: Channel<ChatPatch, void>
  approvalSignal: Signal<ApprovalSignalValue, void>
  reactHandlers?: {
    has(toolName: string): boolean
  }
  handoffResponseSignal?: Signal<{ callId: string; output: unknown }, void>
  uiRequestChannel?: Channel<PendingUIRequest, void>
  emissionChannel?: Channel<PendingEmission, void>
}

function* executeViaReactHandler(
  tool: AnyIsomorphicTool,
  handoff: IsomorphicHandoffEvent,
  patches: Channel<ChatPatch, void>,
  handoffResponseSignal: Signal<{ callId: string; output: unknown }, void>
): Operation<IsomorphicToolResult> {
  const { callId, params, serverOutput } = handoff

  yield* patches.send({
    type: 'pending_handoff',
    handoff: {
      callId,
      toolName: tool.name,
      params,
      data: serverOutput,
      usesHandoff: handoff.usesHandoff ?? false,
    },
  } as ChatPatch)

  let clientOutput: unknown
  for (const response of yield* each(handoffResponseSignal)) {
    if (response.callId === callId) {
      clientOutput = response.output
      break
    }
    yield* each.next()
  }

  yield* patches.send({
    type: 'handoff_complete',
    callId,
  } as ChatPatch)

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
}

export function* executeIsomorphicToolsClientWithReactHandlers(
  options: ReactHandlerExecutionOptions
): Operation<IsomorphicToolResult[]> {
  const {
    handoffs,
    patches,
    approvalSignal,
    reactHandlers,
    handoffResponseSignal,
    uiRequestChannel,
    emissionChannel,
  } = options

  return yield* all(
    handoffs.map(({ tool, handoff }) => {
      if (reactHandlers?.has(tool.name) && handoffResponseSignal) {
        return executeViaReactHandler(tool, handoff, patches, handoffResponseSignal)
      }
      return executeClientPart(tool, handoff, patches, approvalSignal, uiRequestChannel, emissionChannel)
    })
  )
}
