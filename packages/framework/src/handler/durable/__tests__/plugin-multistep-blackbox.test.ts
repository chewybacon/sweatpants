import {
  call,
  createChannel,
  createScope,
  each,
  race,
  run,
  sleep,
  spawn,
  suspend,
  type Operation,
} from 'effection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDurableChatHandler } from '../handler.ts'
import { createPluginSessionManager, type PluginSessionManager } from '../plugin-session-manager.ts'
import type { InitializerHook, McpToolRegistry } from '../types.ts'

import {
  McpToolRegistryContext,
  PluginRegistryContext,
  PluginSessionManagerContext,
  ProviderContext,
  ToolRegistryContext,
} from '../../../lib/chat/providers/contexts.ts'

import { streamChatOnce, type PluginElicitResponseData } from '../../../lib/chat/session/stream-chat.ts'
import type { ApiMessage } from '../../../lib/chat/session/streaming.ts'
import type { ChatPatch } from '../../../lib/chat/patches/index.ts'
import { initialChatState } from '../../../lib/chat/state/chat-state.ts'
import { chatReducer } from '../../../lib/chat/state/reducer.ts'
import { createMcpTool } from '../../../lib/chat/mcp-tools/index.ts'
import { createPluginRegistryFrom } from '../../../lib/chat/mcp-tools/plugin-registry.ts'
import { makePlugin } from '../../../lib/chat/mcp-tools/plugin.ts'
import { createInMemoryToolSessionStore } from '../../../lib/chat/mcp-tools/session/in-memory-store.ts'
import { createToolSessionRegistry } from '../../../lib/chat/mcp-tools/session/session-registry.ts'

import { setupInMemoryDurableStreams } from '../../../lib/chat/durable-streams/index.ts'
import { consumeDurableResponse, createChatRequest, createMockProvider } from './test-utils.ts'

function createSingleToolMcpRegistry(tool: { name: string }): McpToolRegistry {
  const map = new Map<string, unknown>([[tool.name, tool]])
  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    names: () => Array.from(map.keys()),
  }
}

function* withTimeout<T>(label: string, op: Operation<T>, timeoutMs = 5_000): Operation<T> {
  const raced = yield* race([
    (function* (): Operation<{ type: 'ok'; value: T }> {
      const value = yield* op
      return { type: 'ok', value }
    })(),
    (function* (): Operation<{ type: 'timeout' }> {
      yield* sleep(timeoutMs)
      return { type: 'timeout' }
    })(),
  ])

  if (raced.type === 'timeout') {
    throw new Error(`Timeout waiting for: ${label}`)
  }

  return raced.value
}

describe('Plugin multi-step elicitation (black-box)', () => {
  it(
    'round-trips handler output into streamChatOnce across two elicits',
    async () => {
      await run(function* () {
        // ---------------------------------------------------------------------
        // Server-side: build an MCP tool with two sequential elicitations
        // ---------------------------------------------------------------------

        const tool = createMcpTool('book_flight')
          .description('Book a flight (test tool)')
          .parameters(z.object({ from: z.string(), destination: z.string() }))
          .elicits({
            pickFlight: {
              response: z.object({ flightId: z.string() }),
              context: z.object({ flights: z.array(z.object({ id: z.string(), price: z.number() })) }),
            },
            pickSeat: {
              response: z.object({ row: z.number(), seat: z.string() }),
              context: z.object({ seatMap: z.object({ rows: z.number(), seatsPerRow: z.array(z.string()), taken: z.array(z.string()) }) }),
            },
          })
          .execute(function* (_params, ctx) {
            const flight = yield* ctx.elicit('pickFlight', {
              message: 'Pick flight',
              flights: [{ id: 'FL001', price: 123 }],
            })

            if (flight.action !== 'accept') {
              return { ok: false }
            }

            const seat = yield* ctx.elicit('pickSeat', {
              message: 'Pick seat',
              seatMap: { rows: 1, seatsPerRow: ['A'], taken: [] },
            })

            if (seat.action !== 'accept') {
              return { ok: false }
            }

            return {
              ok: true,
              flight: flight.content,
              seat: seat.content,
            }
          })

        // Register as a plugin tool (handlers won’t run here; we respond via
        // pluginElicitResponses). Registration is required for plugin detection.
        const plugin = makePlugin(tool)
          .onElicit({
            pickFlight: function* () {
              return { action: 'cancel' as const }
            },
            pickSeat: function* () {
              return { action: 'cancel' as const }
            },
          })
          .build()

        // NOTE: plugin registry typing is invariant; cast like the app does.
        const pluginRegistry = createPluginRegistryFrom([plugin.client as any])
        const mcpToolRegistry = createSingleToolMcpRegistry(tool)

        // ---------------------------------------------------------------------
        // Long-lived plugin session manager (simulates server startup scope)
        // ---------------------------------------------------------------------

        const [serverScope, destroyServerScope] = createScope()
        const ready = createChannel<PluginSessionManager, void>()

        serverScope.run(function* () {
          const store = createInMemoryToolSessionStore()
          const samplingProvider = {
            *sample() {
              return { text: 'ok', model: 'mock', stopReason: 'endTurn' as const }
            },
          }

          const registry = yield* createToolSessionRegistry(store, { samplingProvider })
          const manager = yield* createPluginSessionManager({ registry })

          yield* ready.send(manager)
          yield* suspend()
        })

        const readySub = yield* ready
        const readyResult = yield* readySub.next()
        if (readyResult.done) {
          throw new Error('PluginSessionManager setup channel closed unexpectedly')
        }
        const pluginSessionManager = readyResult.value

        // ---------------------------------------------------------------------
        // Durable chat handler wired up to the plugin session manager
        // ---------------------------------------------------------------------

        let providerCalls = 0
        const provider = createMockProvider({
          customStream: (messages, options) => {
            const idx = providerCalls++
            if (idx === 0) {
              return createMockProvider({
                responses: 'Calling tool',
                toolCalls: [
                  {
                    id: 'call-1',
                    name: 'book_flight',
                    arguments: { from: 'NYC', destination: 'LA' },
                  },
                ],
              }).stream(messages, options)
            }
            return createMockProvider({ responses: 'Continuing' }).stream(messages, options)
          },
        })

        const initializerHooks: InitializerHook[] = [
          function* setupDurableStreams() {
            yield* setupInMemoryDurableStreams<string>()
          },
          function* setupProvider() {
            yield* ProviderContext.set(provider)
          },
          function* setupTools() {
            yield* ToolRegistryContext.set([])
          },
          function* setupPlugins() {
            yield* PluginRegistryContext.set(pluginRegistry)
            yield* McpToolRegistryContext.set(mcpToolRegistry)
            yield* PluginSessionManagerContext.set(pluginSessionManager)
          },
        ]

        const handler = createDurableChatHandler({ initializerHooks, maxToolIterations: 5 })

        // Mock fetch so streamChatOnce calls the handler.
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          // Extract signal before creating Request to avoid AbortSignal type mismatch
          const { signal, ...restInit } = init ?? {}
          
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url
          
          // Create request without signal (handler doesn't need it for this test)
          return handler(new Request(url, restInit))
        }

        try {
          // -------------------------------------------------------------------
          // Client-side: patches -> reducer (simulates useChatSession state loop)
          // -------------------------------------------------------------------

          const patches = createChannel<ChatPatch, void>()
          let currentState = initialChatState

          yield* spawn(function* () {
            for (const patch of yield* each(patches)) {
              currentState = chatReducer(currentState, patch)
              yield* each.next()
            }
          })

          const messages: ApiMessage[] = [{ role: 'user', content: 'Book a flight' }]

          // Request 1: expect pickFlight elicitation
          const r1 = yield* withTimeout(
            'initial request (expect pickFlight)',
            streamChatOnce(messages, patches, { 
              baseUrl: 'http://localhost/chat',
              enabledPlugins: ['book_flight']
            })
          )
          expect(r1.type).toBe('plugin_elicit')

          if (r1.type !== 'plugin_elicit') {
            throw new Error('Expected plugin_elicit result')
          }

          const first = r1.pendingElicitations[0]
          expect(first).toBeTruthy()
          expect(first!.toolName).toBe('book_flight')
          expect(first!.key).toBe('pickFlight')

          // Ensure client state has the pending elicitation
          expect(currentState.pluginElicitations[first!.callId]).toBeTruthy()

          // Request 2: respond to pickFlight, expect pickSeat elicitation
          const pickFlightResponse: PluginElicitResponseData = {
            sessionId: first!.sessionId,
            callId: first!.callId,
            elicitId: first!.elicitId,
            result: { action: 'accept', content: { flightId: 'FL001' } },
          }

          const r2 = yield* withTimeout(
            'second request (respond pickFlight, expect pickSeat)',
            streamChatOnce(messages, patches, {
              baseUrl: 'http://localhost/chat',
              enabledPlugins: ['book_flight'],
              pluginElicitResponses: [pickFlightResponse],
            })
          )

          expect(r2.type).toBe('plugin_elicit')
          if (r2.type !== 'plugin_elicit') {
            throw new Error('Expected plugin_elicit result')
          }

          const second = r2.pendingElicitations[0]
          expect(second).toBeTruthy()
          expect(second!.key).toBe('pickSeat')

          // Request 3: respond to pickSeat, expect completion
          const pickSeatResponse: PluginElicitResponseData = {
            sessionId: second!.sessionId,
            callId: second!.callId,
            elicitId: second!.elicitId,
            result: { action: 'accept', content: { row: 1, seat: 'A' } },
          }

          const r3 = yield* withTimeout(
            'third request (respond pickSeat, expect complete)',
            streamChatOnce(messages, patches, {
              baseUrl: 'http://localhost/chat',
              enabledPlugins: ['book_flight'],
              pluginElicitResponses: [pickSeatResponse],
            })
          )

          expect(r3.type).toBe('complete')
          yield* patches.close()
        } finally {
          globalThis.fetch = originalFetch
          yield* call(() => destroyServerScope())
        }
      })
    },
    30_000
  )

  it(
    'chains request 1 then request 2 (pluginElicitResponses) and progresses',
    async () => {
      await run(function* () {
        const tool = createMcpTool('book_flight')
          .description('Book a flight (test tool)')
          .parameters(z.object({ from: z.string(), destination: z.string() }))
          .elicits({
            pickFlight: {
              response: z.object({ flightId: z.string() }),
              context: z.object({ flights: z.array(z.object({ id: z.string(), price: z.number() })) }),
            },
            pickSeat: {
              response: z.object({ row: z.number(), seat: z.string() }),
              context: z.object({ seatMap: z.object({ rows: z.number(), seatsPerRow: z.array(z.string()), taken: z.array(z.string()) }) }),
            },
          })
          .execute(function* (_params, ctx) {
            const flight = yield* ctx.elicit('pickFlight', {
              message: 'Pick flight',
              flights: [{ id: 'FL001', price: 123 }],
            })

            if (flight.action !== 'accept') {
              return { ok: false }
            }

            const seat = yield* ctx.elicit('pickSeat', {
              message: 'Pick seat',
              seatMap: { rows: 1, seatsPerRow: ['A'], taken: [] },
            })

            if (seat.action !== 'accept') {
              return { ok: false }
            }

            return { ok: true, flight: flight.content, seat: seat.content }
          })

        const plugin = makePlugin(tool)
          .onElicit({
            pickFlight: function* () {
              return { action: 'cancel' as const }
            },
            pickSeat: function* () {
              return { action: 'cancel' as const }
            },
          })
          .build()

        const pluginRegistry = createPluginRegistryFrom([plugin.client as any])
        const mcpToolRegistry = createSingleToolMcpRegistry(tool)

        // Long-lived plugin session manager
        const [serverScope, destroyServerScope] = createScope()
        const ready = createChannel<PluginSessionManager, void>()

        serverScope.run(function* () {
          const store = createInMemoryToolSessionStore()
          const samplingProvider = {
            *sample() {
              return { text: 'ok', model: 'mock', stopReason: 'endTurn' as const }
            },
          }

          const registry = yield* createToolSessionRegistry(store, { samplingProvider })
          const manager = yield* createPluginSessionManager({ registry })

          yield* ready.send(manager)
          yield* suspend()
        })

        const readySub = yield* ready
        const readyResult = yield* readySub.next()
        if (readyResult.done) {
          throw new Error('PluginSessionManager setup channel closed unexpectedly')
        }
        const pluginSessionManager = readyResult.value

        // Deterministic provider: tool call only on first provider invocation
        let providerCalls = 0
        const provider = createMockProvider({
          customStream: (messages, options) => {
            const idx = providerCalls++
            if (idx === 0) {
              return createMockProvider({
                responses: 'Calling tool',
                toolCalls: [
                  {
                    id: 'call-1',
                    name: 'book_flight',
                    arguments: { from: 'NYC', destination: 'LA' },
                  },
                ],
              }).stream(messages, options)
            }
            return createMockProvider({ responses: 'Continuing' }).stream(messages, options)
          },
        })

        const initializerHooks: InitializerHook[] = [
          function* setupDurableStreams() {
            yield* setupInMemoryDurableStreams<string>()
          },
          function* setupProvider() {
            yield* ProviderContext.set(provider)
          },
          function* setupTools() {
            yield* ToolRegistryContext.set([])
          },
          function* setupPlugins() {
            yield* PluginRegistryContext.set(pluginRegistry)
            yield* McpToolRegistryContext.set(mcpToolRegistry)
            yield* PluginSessionManagerContext.set(pluginSessionManager)
          },
        ]

        const handler = createDurableChatHandler({ initializerHooks, maxToolIterations: 5 })

        try {
          // REQUEST 1
          const { request: request1 } = createChatRequest(
            [{ role: 'user', content: 'Book a flight' }],
            { enabledTools: true, enabledPlugins: ['book_flight'] }
          )

          const response1 = yield* call(() => handler(request1))
          const result1 = yield* withTimeout(
            'consume request 1 response',
            call(() => consumeDurableResponse(response1))
          )

          const elicit1 = result1.events
            .map(({ event }) => event as any)
            .find((e) => e.type === 'plugin_elicit_request') as any | undefined

          expect(elicit1).toBeTruthy()
          expect(elicit1!.key).toBe('pickFlight')

          // REQUEST 2 (black-box resume)
          const pickFlightResponse: PluginElicitResponseData = {
            sessionId: elicit1!.sessionId,
            callId: elicit1!.callId,
            elicitId: elicit1!.elicitId,
            result: { action: 'accept', content: { flightId: 'FL001' } },
          }

          const request2 = new Request('http://localhost/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'Book a flight' }],
              enabledTools: true,
              enabledPlugins: ['book_flight'],
              pluginElicitResponses: [pickFlightResponse],
            }),
          })

          const response2 = yield* call(() => handler(request2))
          const result2 = yield* withTimeout(
            'consume request 2 response',
            call(() => consumeDurableResponse(response2))
          )

          const elicit2 = result2.events
            .map(({ event }) => event as any)
            .find((e) => e.type === 'plugin_elicit_request') as any | undefined

          expect(elicit2).toBeTruthy()
          expect(elicit2!.callId).toBe(elicit1!.callId)
          expect(elicit2!.key).toBe('pickSeat')
        } finally {
          yield* call(() => destroyServerScope())
        }
      })
    },
    30_000
  )
})
