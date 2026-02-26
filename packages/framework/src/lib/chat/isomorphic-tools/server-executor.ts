/**
 * Server-side execution for isomorphic tools.
 */
import type { Operation } from 'effection'
import type {
  AnyIsomorphicTool,
  ServerToolContext,
  ServerAuthorityContext,
  IsomorphicHandoffEvent,
  HandoffConfig,
} from './types.ts'
import { HandoffReadyError } from './types.ts'
import { validateToolParams } from '../utils.ts'

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

  const validatedParams = validateToolParams(tool, params)

  if (!tool.server) {
    throw new Error(`Isomorphic tool "${tool.name}" has no server function`)
  }

  const phase1Context = createPhase1Context(baseContext)

  try {
    const serverOutput = yield* tool.server(validatedParams, phase1Context)

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
        usesHandoff: false,
      },
      serverOutput,
      usesHandoff: false,
    }
  } catch (e) {
    if (e instanceof HandoffReadyError) {
      return {
        kind: 'handoff',
        handoff: {
          type: 'isomorphic_handoff',
          callId,
          toolName: tool.name,
          params: validatedParams,
          serverOutput: e.handoffData,
          usesHandoff: true,
        },
        serverOutput: e.handoffData,
        usesHandoff: true,
      }
    }
    throw e
  }
}

export function* executeServerPhase2(
  tool: AnyIsomorphicTool,
  callId: string,
  params: unknown,
  clientOutput: unknown,
  cachedHandoff: unknown,
  signal: AbortSignal,
  usesHandoff: boolean
): Operation<unknown> {
  const validatedParams = validateToolParams(tool, params)

  if (!usesHandoff) {
    return cachedHandoff
  }

  if (!tool.server) {
    throw new Error(`Isomorphic tool "${tool.name}" has no server function`)
  }

  const baseContext: ServerToolContext = {
    callId,
    signal,
  }

  const phase2Context = createPhase2Context(baseContext, cachedHandoff, clientOutput)

  return yield* tool.server(validatedParams, phase2Context)
}
