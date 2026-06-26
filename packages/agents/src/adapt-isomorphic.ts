/**
 * adaptIsomorphicTool — turn a `createIsomorphicTool` `FinalizedIsomorphicTool`
 * into a `UnifiedToolFactory` the unified agent `ctx.call` can invoke
 * (design DD3/DD5).
 *
 * Two cases:
 *  - **server-only** (`.server(fn)`): runs `server(params, serverCtx)`.
 *  - **handoff** (`.handoff({ before, client, after })`): before → client → after.
 *    The `client()` phase runs in-process; its `waitFor`/`prompt`/`requestApproval`/
 *    `emit` calls are shimmed onto the unified `ToolCtx` (elicit/sample/notify),
 *    so they flow through the stream as `elicit_request`/`sample_request`/`progress`
 *    events and park on the shared router.
 *
 * Existing isomorphic `client-executor`/`react-executor` paths untouched (NFR-004).
 */

import type { Operation } from 'effection'

import type { ToolCtx, UnifiedToolFactory } from './tool-ctx.ts'

// Structural view of FinalizedIsomorphicTool (avoids importing framework types).
export interface IsomorphicToolLike<TParams = any, TResult = any> {
  name: string
  description: string
  parameters: {
    safeParse: (v: unknown) => {
      success: boolean
      data?: TParams
      error?: { message: string }
    }
  }
  contextMode?: string
  handoffConfig?: {
    before: (params: TParams, ctx: IsomorphicServerCtxLike) => Operation<unknown>
    client: (handoff: unknown, ctx: IsomorphicClientCtxLike, params: TParams) => Operation<unknown>
    after: (handoff: unknown, client: unknown, ctx: IsomorphicServerCtxLike, params: TParams) => Operation<TResult>
  }
  server?: (params: TParams, ctx: IsomorphicServerCtxLike) => Operation<TResult>
}

export interface IsomorphicServerCtxLike {
  callId: string
  signal: AbortSignal
}

export interface IsomorphicClientCtxLike {
  callId: string
  signal: AbortSignal
  waitFor: <TPayload, TResponse>(type: string, payload: TPayload) => Operation<TResponse>
  prompt: <T>(opts: { prompt: string; schema?: unknown; system?: string }) => Operation<T>
  requestApproval: (message: string) => Operation<{ approved: true } | { approved: false; reason?: string }>
  emit?: (event: unknown) => Operation<void>
}

export function adaptIsomorphicTool<I, O>(
  tool: IsomorphicToolLike<I, O>,
): UnifiedToolFactory<I, O> {
  const factory = function isomorphicToolFactory(
    ctx: ToolCtx,
  ): Operation<(input: I) => Operation<O>> {
    return {
      *[Symbol.iterator]() {
        const serverCtx: IsomorphicServerCtxLike = {
          callId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          signal: new AbortController().signal,
        }
        const clientCtx = makeIsomorphicClientCtx(ctx, serverCtx.callId)

        const invoke = (input: I): Operation<O> =>
          (function* (): Operation<O> {
            const parsed = tool.parameters.safeParse(input)
            if (!parsed.success || parsed.data === undefined) {
              throw new Error(
                `Invalid params for tool "${tool.name}": ${parsed.error?.message ?? 'validation failed'}`,
              )
            }
            const params = parsed.data as I

            if (tool.handoffConfig) {
              const { before, client: clientFn, after } = tool.handoffConfig
              const handoff = yield* before(params, serverCtx)
              const clientResult = yield* clientFn(handoff, clientCtx, params)
              return yield* after(handoff, clientResult, serverCtx, params)
            }

            if (tool.server) {
              return yield* tool.server(params, serverCtx)
            }

            throw new Error(`Tool "${tool.name}" has no server or handoffConfig`)
          })()

        return invoke
      },
    }
  }

  Object.defineProperty(factory, 'name', { value: tool.name, writable: false })
  Object.defineProperty(factory, 'description', {
    value: tool.description,
    writable: false,
  })
  Object.defineProperty(factory, 'schemas', {
    value: { input: tool.parameters, output: undefined },
    writable: false,
  })
  Object.defineProperty(factory, 'capabilities', {
    value: { elicitation: true, sampling: tool.contextMode === 'agent' },
    writable: false,
  })

  return factory as unknown as UnifiedToolFactory<I, O>
}

function makeIsomorphicClientCtx(
  ctx: ToolCtx,
  callId: string,
): IsomorphicClientCtxLike {
  return {
    callId,
    signal: new AbortController().signal,

    // waitFor → dynamic elicit keyed by the UI handler type; the payload is the request.
    *waitFor(type, payload) {
      const res = yield* ctx.elicitDynamic({
        key: type,
        message: `UI request: ${type}`,
        responseSchema: payload,
      })
      if (res.action !== 'accept') {
        throw new Error(`waitFor("${type}") was ${res.action}`)
      }
      return res.content as never
    },

    // prompt → sample (structured LLM completion).
    *prompt(opts) {
      const res = yield* ctx.sample({ prompt: opts.prompt })
      // The unified sample returns a string; isomorphic prompt expects a parsed
      // T. For the in-process/test path we return the raw string cast — a real
      // provider with a schema would parse. (Remote/structured is stage 2.)
      return res.content as never
    },

    // requestApproval → dynamic elicit keyed "approval".
    *requestApproval(message) {
      const res = yield* ctx.elicitDynamic({ key: 'approval', message })
      if (res.action === 'accept') {
        return { approved: true as const }
      }
      const declined: { approved: false; reason?: string } = { approved: false }
      if (res.reason !== undefined) {
        declined.reason = res.reason
      }
      return declined
    },

    *emit(event) {
      yield* ctx.notify(typeof event === 'string' ? event : JSON.stringify(event))
    },
  }
}
