import {
  call,
  createChannel,
  createScope,
  createSignal,
  each,
  race,
  run,
  sleep,
  spawn,
  suspend,
  type Operation,
} from 'effection'
import { describe, expect, it } from 'vitest'

import { createChatHandler } from '@sweatpants/framework/handler'
import {
  createPluginSessionManager,
  type PluginSessionManager,
} from '@sweatpants/framework/handler/durable'

import { setupInMemoryDurableStreams } from '@sweatpants/framework/chat/durable-streams'

import {
  McpToolRegistryContext,
  PluginRegistryContext,
  PluginSessionManagerContext,
  ProviderContext,
  ToolRegistryContext,
} from '@sweatpants/framework/chat'

import {
  streamChatOnce,
  type ElicitResponseData,
} from '../../../../packages/framework/src/lib/chat/session/stream-chat.ts'
import type { Message } from '../../../../packages/framework/src/lib/chat/types.ts'
import type { StreamResult } from '../../../../packages/framework/src/lib/chat/session/streaming.ts'
import type { ChatPatch } from '../../../../packages/framework/src/lib/chat/patches/index.ts'

import { initialChatState, chatReducer } from '../../../../packages/framework/src/lib/chat/state/index.ts'

import { createPluginRegistryFrom } from '@sweatpants/framework/chat/mcp-tools'
import { createInMemoryToolSessionStore, createToolSessionRegistry } from '@sweatpants/framework/chat/mcp-tools'

import {
  executeClientPart,
  executeServerPart,
  executeServerPhase2,
} from '@sweatpants/framework/chat/isomorphic-tools'
import type { IsomorphicHandoffEvent } from '@sweatpants/framework/chat/isomorphic-tools'
import type { ApprovalSignalValue } from '../../../../packages/framework/src/lib/chat/isomorphic-tools/runtime/tool-runtime.ts'
import type { PendingEmission } from '../../../../packages/framework/src/lib/chat/isomorphic-tools/runtime/emissions.ts'

import { createMockProvider } from '../../../../packages/framework/src/handler/durable/__tests__/test-utils.ts'
import { pickCard } from '../tools/pick-card'
import { bookFlightTool, bookFlightPlugin } from '../tools/book-flight'

function createSingleToolMcpRegistry(tool: { name: string }) {
  const map = new Map<string, unknown>([[tool.name, tool]])
  return {
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
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

describe('yo-chat tool blackbox', () => {
  it(
    'book_flight runs through pickFlight and pickSeat elicits',
    async () => {
      await run(function* () {
        const pluginRegistry = createPluginRegistryFrom([bookFlightPlugin.client as any])
        const mcpToolRegistry = createSingleToolMcpRegistry(bookFlightTool)

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
                    name: bookFlightTool.name,
                    arguments: { from: 'NYC', destination: 'LAX' },
                  },
                ],
              }).stream(messages, options)
            }
            return createMockProvider({ responses: 'Continuing' }).stream(messages, options)
          },
        })

        const initializerHooks = [
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

        const handler = createChatHandler({ initializerHooks, maxToolIterations: 5 })

        const originalFetch = globalThis.fetch
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const { signal, ...restInit } = init ?? {}
          const url = typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
          return handler(new Request(url, restInit))
        }

        try {
          const patches = createChannel<ChatPatch, void>()
          let currentState = initialChatState

          yield* spawn(function* () {
            for (const patch of yield* each(patches)) {
              currentState = chatReducer(currentState, patch)
              yield* each.next()
            }
          })

          const messages: Message[] = [{ role: 'user', content: 'Book a flight' }]

          const r1 = yield* withTimeout(
            'initial request (expect pickFlight)',
            streamChatOnce(messages, patches, {
              baseUrl: 'http://localhost/chat',
              enabledPlugins: [bookFlightTool.name],
            })
          )

          const r1Result = r1 as StreamResult
          expect(r1Result.type).toBe('elicit')
          if (r1Result.type !== 'elicit') {
            throw new Error('Expected elicit result')
          }

          const first = r1Result.pendingElicitations[0]
          expect(first?.key).toBe('pickFlight')
          expect(currentState.pendingElicits[first!.callId]).toBeTruthy()

          const pickFlightResponse: ElicitResponseData = {
            sessionId: first!.sessionId,
            callId: first!.callId,
            elicitId: first!.elicitId,
            result: { action: 'accept', content: { flightId: 'FL001' } },
          }

          const r2 = yield* withTimeout(
            'second request (respond pickFlight, expect pickSeat)',
            streamChatOnce(messages, patches, {
              baseUrl: 'http://localhost/chat',
              enabledPlugins: [bookFlightTool.name],
              elicitResponses: [pickFlightResponse],
            })
          )

          const r2Result = r2 as StreamResult
          expect(r2Result.type).toBe('elicit')
          if (r2Result.type !== 'elicit') {
            throw new Error('Expected elicit result')
          }

          const second = r2Result.pendingElicitations[0]
          expect(second?.key).toBe('pickSeat')

          const pickSeatResponse: ElicitResponseData = {
            sessionId: second!.sessionId,
            callId: second!.callId,
            elicitId: second!.elicitId,
            result: { action: 'accept', content: { row: 1, seat: 'A' } },
          }

          const r3 = yield* withTimeout(
            'third request (respond pickSeat, expect complete)',
            streamChatOnce(messages, patches, {
              baseUrl: 'http://localhost/chat',
              enabledPlugins: [bookFlightTool.name],
              elicitResponses: [pickSeatResponse],
            })
          )

          const r3Result = r3 as StreamResult
          expect(r3Result.type).toBe('complete')
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
    'pick_card executes server/client phases via handoff',
    async () => {
      const anyTool = pickCard as any
      const signal = new AbortController().signal

      await run(function* () {
        const phase1 = yield* executeServerPart(anyTool, 'call-1', { count: 3 }, signal)

        expect(phase1.kind).toBe('handoff')
        if (phase1.kind !== 'handoff') {
          throw new Error('Expected handoff result')
        }

        const patches = createChannel<ChatPatch, void>()
        const approvalSignal = createSignal<ApprovalSignalValue, void>()
        const emissionChannel = createChannel<PendingEmission, void>()

        const handoff = phase1.handoff as IsomorphicHandoffEvent

        const emissionSub = yield* emissionChannel
        yield* spawn(function* () {
          const next = yield* emissionSub.next()
          if (next.done) return
          const emission = next.value
          const serverOutput = handoff.serverOutput as { cards: Array<{ rank: string; suit: string; display: string }> }
          emission.respond({ picked: serverOutput.cards[0] })
        })

        yield* spawn(function* () {
          yield* sleep(10)
          approvalSignal.send({ callId: handoff.callId, approved: true })
        })

        const clientResult = yield* executeClientPart(
          anyTool,
          handoff,
          patches,
          approvalSignal,
          undefined,
          emissionChannel
        )

        expect(clientResult.ok).toBe(true)

        const serverResult = yield* executeServerPhase2(
          anyTool,
          handoff.callId,
          handoff.params,
          clientResult.clientOutput,
          phase1.serverOutput,
          signal,
          handoff.usesHandoff ?? false
        )

        expect(serverResult).toMatch(/The user selected the/)
      })
    },
    20_000
  )
})
