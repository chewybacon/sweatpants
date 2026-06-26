/**
 * adaptMCPTool — turn a `createMCPTool` `FinalizedMCPTool` into a
 * `UnifiedToolFactory` the unified agent `ctx.call` can invoke (design DD3/DD5).
 *
 * The MCP tool's `execute(params, mcpCtx)` or `handoff({before, client, after})`
 * is re-expressed as a single `(input, ctx: ToolCtx) => Operation<out>`:
 *
 *  - **execute**: runs `execute(input, mcpCtx)` where `mcpCtx` is a shim over
 *    the unified `ToolCtx` (`elicit`/`sample`/`notify`; `log`→`notify`).
 *  - **handoff**: runs `before(input, serverCtx)`, then `client(handoff,
 *    mcpCtx)` in-process (its elicit/sample calls flow through the stream via
 *    the ToolCtx shim), then `after(handoff, client, serverCtx, input)`.
 *
 * The client phase runs in-process against the shimmed ctx — its `ctx.elicit`
 * and `ctx.sample` calls become `AgentEvent`s on the stream and park on the
 * shared router, so a session driver (or test) fulfills them via
 * `respondElicit`/`respondSample`. This is the local-fulfillment path; a remote
 * client executor (React/MCP host) is stage-2 work and will park the handoff on
 * `ctx.elicit("client", …)` to be fulfilled by a registered executor.
 *
 * The existing `mock-runtime`/`bridge-runtime` paths are untouched (NFR-004).
 */

import type { Operation } from 'effection'

import type { ToolCtx, UnifiedToolFactory } from './tool-ctx.ts'

// Minimal structural view of a FinalizedMCPTool (avoids importing framework
// types into the agents package). Structurally typed so any matching object
// works — including `createMCPTool(...).handoff(...)`.
export interface MCPToolLike<TParams = any, TResult = any> {
  name: string
  description: string
  parameters: {
    safeParse: (v: unknown) => {
      success: boolean
      data?: TParams
      error?: { message: string }
    }
  }
  requires?: { elicitation?: boolean; sampling?: boolean }
  execute?: (params: TParams, ctx: MCPClientCtxLike) => Operation<TResult>
  handoffConfig?: {
    before: (params: TParams, ctx: MCPServerCtxLike) => Operation<unknown>
    client: (handoff: unknown, ctx: MCPClientCtxLike) => Operation<unknown>
    after: (
      handoff: unknown,
      client: unknown,
      ctx: MCPServerCtxLike,
      params: TParams,
    ) => Operation<TResult>
  }
}

/** Structural `MCPClientContext` (elicit/sample/log/notify) the client fn expects. */
export interface MCPClientCtxLike {
  elicit: (config: {
    message: string
    schema?: unknown
  }) => Operation<{ action: string; content?: unknown; reason?: string; [key: string]: unknown }>
  sample: (config: {
    prompt: string
    maxTokens?: number
    schema?: unknown
  }) => Operation<string>
  log: (level: string, message: string) => Operation<void>
  notify: (message: string, progress?: number) => Operation<void>
}

/** Structural `MCPServerContext` (callId/signal) before/after expect. */
export interface MCPServerCtxLike {
  callId: string
  signal: AbortSignal
}

/**
 * Adapt a `FinalizedMCPTool` (structurally) into a `UnifiedToolFactory`.
 * No client executor needed for the in-process path (design DD3, local fulfillment).
 */
export function adaptMCPTool<I, O>(
  tool: MCPToolLike<I, O>,
): UnifiedToolFactory<I, O> {
  const factory = function mcpToolFactory(
    ctx: ToolCtx,
  ): Operation<(input: I) => Operation<O>> {
    return {
      *[Symbol.iterator]() {
        const mcpClientCtx = makeMCPClientCtx(ctx)
        const serverCtx: MCPServerCtxLike = {
          callId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          signal: new AbortController().signal,
        }

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
              // Client phase runs in-process; its elicit/sample calls flow
              // through the stream via the ToolCtx shim and park on the router.
              const clientResult = yield* clientFn(handoff, mcpClientCtx)
              return yield* after(handoff, clientResult, serverCtx, params)
            }

            if (tool.execute) {
              return yield* tool.execute(params, mcpClientCtx)
            }

            throw new Error(`Tool "${tool.name}" has no execute or handoffConfig`)
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
    value: tool.requires ?? { elicitation: false, sampling: false },
    writable: false,
  })

  return factory as unknown as UnifiedToolFactory<I, O>
}

// ---------------------------------------------------------------------------
// ToolCtx → MCPClientCtx shim
// ---------------------------------------------------------------------------

function makeMCPClientCtx(ctx: ToolCtx): MCPClientCtxLike {
  return {
    *elicit(config) {
      const res = yield* ctx.elicitDynamic({
        key: 'elicit',
        message: config.message,
        responseSchema: config.schema,
      })
      if (res.action === 'accept') {
        return {
          status: 'accepted' as const,
          action: 'accept',
          content: res.content,
        }
      }
      const declined: { action: string; content?: unknown; reason?: string; status: string } = {
        status: res.action === 'decline' ? 'declined' : 'cancelled',
        action: res.action,
        content: undefined,
      }
      if (res.reason !== undefined) {
        declined.reason = res.reason
      }
      return declined
    },
    *sample(config) {
      const options: { prompt: string; maxTokens?: number; schema?: unknown } = { prompt: config.prompt }
      if (config.maxTokens !== undefined) options.maxTokens = config.maxTokens
      if (config.schema !== undefined) options.schema = config.schema
      const res = yield* ctx.sample(options)
      return res.content
    },
    log(level, message) {
      return ctx.log(level as never, message)
    },
    notify(message, progress) {
      return ctx.notify(message, progress)
    },
  }
}
