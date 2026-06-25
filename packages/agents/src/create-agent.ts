/**
 * createAgent — define an agent as a callable coroutine (Spec REQ-001).
 *
 * Built alongside the existing `@sweatpants/core` `createAgent` (tool-grouping
 * helper) per the NFR-004 migration strategy. This is the unified agent model:
 * an `entry` harness + `tools` + optional `subAgents` + `model`, composable
 * in-process and deployable over a protocol handler with no definition change.
 *
 * The agent's invocation surface is backed by `createApi` from
 * `effection/experimental` — the same machinery `createTool` uses — so
 * middleware (`decorate`) composes via `api.around`, and the per-run `AgentCtx`
 * is delivered through an Effection `Context` rather than closure capture.
 */

import { createContext } from 'effection'
import { createApi } from 'effection/experimental'
import type { Operation } from 'effection'

import type {
  AnyToolFactory,
  AgentConfig,
  AgentFactory,
  AgentInstance,
  AgentMiddleware,
  ModelSelection,
} from './types.ts'
import { buildAgentCtx, createRequestRouter, generateId } from './ctx.ts'
import { driveEntry } from './driver.ts'
import { createAgentStream, createInMemoryAgentStreamStore } from './stream.ts'
import type { AgentCtx } from './ctx.ts'
import type { AgentMessage, AgentState } from './events.ts'
import type { AgentStream } from './stream.ts'
import type { RequestRouter, SampleProvider } from './ctx.ts'
import { AGENT_RUN, getRun, type RunOptions } from './internal.ts'

export function createAgent<
  I,
  O,
  TTools extends Record<string, AnyToolFactory>,
  TSub extends
    | Record<string, AgentFactory<any, any, any, any>>
    | undefined = undefined,
>(
  config: AgentConfig<I, O, TTools, TSub>,
): AgentFactory<I, O, TTools, TSub> {
  // The per-run AgentCtx is delivered through this context so the createApi
  // `invoke` handler can reach it without closure capture across recursive
  // sub-agent runs (each agent owns its own context, keyed by name).
  const invocationCtx = createContext<AgentCtx<TTools, TSub>>(
    `agent.${config.name}.invocation-ctx`,
  )

  // The agent's invocation surface — mirrors createTool's shape.
  const api = createApi(config.name, {
    *invoke(input: I): Operation<O> {
      const ctx = yield* invocationCtx.get()
      if (!ctx) {
        throw new Error(
          `Agent "${config.name}" invoke handler has no AgentCtx in scope. ` +
            `This should never happen — driveEntry installs it before invoking.`,
        )
      }
      return yield* (config.entry(input, ctx) as Operation<O>)
    },
  })

  /**
   * Internal run: build the per-run AgentCtx, install it in the invocation
   * context, and dispatch through `api.operations.invoke` so agent middleware
   * composes. Called by `driveEntry` (and recursively for sub-agents).
   */
  function* run(input: unknown, opts: RunOptions): Operation<unknown> {
    const ctx = buildAgentCtx({
      agent: factory as AgentFactory<any, any, any, any>,
      stream: opts.stream,
      subSessionId: opts.subSessionId,
      router: opts.router,
      sampleProvider: opts.sampleProvider,
      messages: opts.messages,
      state: opts.state,
      invokeSubAgent: (subFactory, subInput, subSessionId) =>
        driveEntry(subFactory as AgentFactory<any, any, any, any>, subInput, {
          stream: opts.stream,
          subSessionId,
          router: opts.router,
          sampleProvider: opts.sampleProvider,
          messages: [],
          state: {},
        }),
    })
    return yield* invocationCtx.with(
      ctx as AgentCtx<TTools, TSub>,
      () => api.operations.invoke(input as I),
    )
  }

  /** Activate the agent; returns an instance whose `invoke` runs the entry. */
  function factory(): Operation<AgentInstance<I, O>> {
    return {
      *[Symbol.iterator]() {
        const self = factory as unknown as AgentFactory<I, O, TTools, TSub>
        const instance: AgentInstance<I, O> = {
          factory: self as unknown as AgentFactory<I, O, any, any>,
          invoke(input: I): Operation<O> {
            // Ephemeral in-process run: an isolated stream + router, no durability.
            const store = createInMemoryAgentStreamStore()
            return (function* (): Operation<O> {
              const contextId = `ephemeral-${generateId()}`
              const buffer = yield* store.getOrCreate(contextId)
              const stream = createAgentStream(
                contextId,
                buffer,
                store.checkpointIndex,
              )
              const router = createRequestRouter()
              const result = yield* run(input, {
                stream,
                router,
                messages: [],
                state: {},
                subSessionId: undefined,
                sampleProvider: undefined,
              })
              return result as O
            })()
          },
        }
        return instance
      },
    }
  }

  /** Register middleware around the agent's `entry` invocation. */
  function* decorate(middleware: AgentMiddleware<I, O>): Operation<void> {
    yield* api.around({
      *invoke([input]: [I], next: (...args: [I]) => Operation<O>) {
        return yield* middleware(input, (...a: [I]) => next(...a))
      },
    })
  }

  const fn = factory as unknown as AgentFactory<I, O, TTools, TSub> & {
    [AGENT_RUN]: typeof run
  }
  // Attach the internal run handle (non-enumerated) for driveEntry.
  Object.defineProperty(fn, AGENT_RUN, { value: run, enumerable: false })

  Object.defineProperty(fn, 'name', { value: config.name, writable: false })
  Object.defineProperty(fn, 'description', {
    value: config.description,
    writable: false,
  })
  Object.defineProperty(fn, 'systemPrompt', {
    value: config.systemPrompt,
    writable: false,
  })
  Object.defineProperty(fn, 'tools', { value: config.tools, writable: false })
  Object.defineProperty(fn, 'subAgents', {
    value: config.subAgents,
    writable: false,
  })
  Object.defineProperty(fn, 'model', { value: config.model, writable: false })
  Object.defineProperty(fn, 'maxIterations', {
    value: config.maxIterations,
    writable: false,
  })
  Object.defineProperty(fn, 'goal', { value: config.goal, writable: false })
  Object.defineProperty(fn, 'entry', { value: config.entry, writable: false })
  Object.defineProperty(fn, 'decorate', { value: decorate, writable: false })

  return fn
}

// ----------------------------------------------------------------------------
// Re-exports for handlers/projections (stage 2) and driver wiring.
// ----------------------------------------------------------------------------

export { getRun }
export type { RunOptions, AgentStream, RequestRouter, SampleProvider, ModelSelection }
export type { AgentMessage, AgentState }
