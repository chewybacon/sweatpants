import {
  call,
  createChannel,
  createScope,
  each,
  run,
  sleep,
  spawn,
  suspend,
  type Operation,
} from 'effection'
import { describe, expect, it } from 'vitest'

import { createChatHandler } from '@sweatpants/framework/server'
import {
  FoldSessionBufferStoreContext,
  createPluginSessionManager,
  createSessionContractInMemoryStore,
  type PluginSessionManager,
} from '@sweatpants/framework/server'
import { setupInMemoryDurableStreams } from '@sweatpants/framework/chat/durable-streams'
import {
  McpToolRegistryContext,
  PluginRegistryContext,
  PluginSessionManagerContext,
  ToolInventoryContext,
  createToolInventory,
} from '@sweatpants/framework/chat'
import { createChatSession } from '../../../../packages/framework/src/lib/chat/session/create-session.ts'
import type { Message } from '../../../../packages/framework/src/lib/chat/types.ts'
import type { ChatState } from '../../../../packages/framework/src/lib/chat/state/chat-state.ts'
import { initialChatState } from '../../../../packages/framework/src/lib/chat/state/index.ts'
import { createPluginRegistryFrom, type ToolSessionRegistry } from '@sweatpants/framework/chat/mcp-tools'
import {
  createInMemoryToolSessionStore,
  createToolInventoryEntry,
  createToolSessionRegistry,
  installLocalToolRuntime,
} from '@sweatpants/tool-runtime-local'
import {
  createMockProvider,
  setupMockModelProvider,
} from '../../../../packages/framework/src/handler/durable/__tests__/test-utils.ts'
import { bookFlightPlugin, bookFlightTool } from '../tools/book-flight'

type LocalSessionTool = Parameters<typeof createToolInventoryEntry>[0]
type PendingElicit = ChatState['pendingElicits'][string]['elicitations'][number]

function createSingleToolMcpRegistry(tool: { name: string }) {
  const map = new Map<string, unknown>([[tool.name, tool]])
  return {
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
    names: () => Array.from(map.keys()),
  }
}

function findPendingElicit(state: ChatState, key: string): PendingElicit | null {
  for (const tracking of Object.values(state.pendingElicits)) {
    for (const elicit of tracking.elicitations) {
      if (elicit.key === key && elicit.status === 'pending') {
        return elicit
      }
    }
  }
  return null
}

function* waitForState(
  label: string,
  getState: () => ChatState,
  predicate: (state: ChatState) => boolean,
  timeoutMs = 20_000,
): Operation<ChatState> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const state = getState()
    if (predicate(state)) return state
    yield* sleep(25)
  }
  throw new Error(`Timeout waiting for state: ${label}`)
}

function transcriptHasOutboundBooking(messages: Message[]): boolean {
  return messages.some((message) => {
    const content = message.content
    if (message.role === 'tool') {
      return (
        content.includes('Los Angeles') ||
        content.includes('New York') ||
        content.includes('"from":"Los Angeles"') ||
        content.includes('"to":"New York"') ||
        /from Los Angeles to New York/i.test(content)
      )
    }
    if (message.role === 'assistant') {
      return /Los Angeles|New York|outbound/i.test(content)
    }
    if (message.role === 'user') {
      return /Los Angeles to New York/i.test(content)
    }
    return false
  })
}

describe('book_flight return history', () => {
  it('infers return route from prior outbound booking history without restating cities', async () => {
    await run(function* () {
      const pluginRegistry = createPluginRegistryFrom([bookFlightPlugin.client as any])
      const mcpToolRegistry = createSingleToolMcpRegistry(bookFlightTool)

      const [serverScope, destroyServerScope] = createScope()
      const ready = createChannel<
        { registry: ToolSessionRegistry; manager: PluginSessionManager; samplingProvider: any },
        void
      >()

      serverScope.run(function* () {
        const store = createInMemoryToolSessionStore()
        const samplingProvider = {
          *sample() {
            return { text: 'Arrive early and keep your ID handy.', model: 'mock', stopReason: 'endTurn' as const }
          },
        }
        const registry = yield* createToolSessionRegistry(store, { samplingProvider })
        const manager = yield* createPluginSessionManager({ registry })
        yield* ready.send({ registry, manager, samplingProvider })
        yield* suspend()
      })

      const readySub = yield* ready
      const readyResult = yield* readySub.next()
      if (readyResult.done) {
        throw new Error('PluginSessionManager setup channel closed unexpectedly')
      }
      const {
        registry: toolSessionRegistry,
        manager: pluginSessionManager,
        samplingProvider,
      } = readyResult.value

      const providerMessages: Message[][] = []
      const returnInference: Array<{ canInferReturn: boolean; args?: Record<string, unknown> }> = []
      const foldSessionBufferStore = createSessionContractInMemoryStore()
      const provider = createMockProvider({
        customStream: (messages, options) => {
          const transcript = messages.map((message) => message.content).join('\n')
          if (transcript.includes('Give a brief, helpful travel tip')) {
            return createMockProvider({ responses: 'Arrive early and keep your ID handy.' }).stream(
              messages,
              options,
            )
          }

          providerMessages.push(JSON.parse(JSON.stringify(messages)) as Message[])
          const lastMessage = messages[messages.length - 1]

          if (lastMessage?.role === 'user' && /book the return flight/i.test(lastMessage.content)) {
            const canInferReturn = transcriptHasOutboundBooking(messages)
            const args = canInferReturn
              ? { from: 'New York', destination: 'Los Angeles' }
              : undefined
            returnInference.push({ canInferReturn, ...(args ? { args } : {}) })
            return createMockProvider({
              responses: canInferReturn
                ? 'Calling return flight tool from history'
                : 'I need origin and destination to book a return flight.',
              toolCalls: canInferReturn
                ? [
                    {
                      id: 'return-call-1',
                      name: bookFlightTool.name,
                      arguments: args!,
                    },
                  ]
                : [],
            }).stream(messages, options)
          }

          if (lastMessage?.role === 'user') {
            return createMockProvider({
              responses: 'Calling outbound flight tool',
              toolCalls: [
                {
                  id: 'outbound-call-1',
                  name: bookFlightTool.name,
                  arguments: { from: 'Los Angeles', destination: 'New York' },
                },
              ],
            }).stream(messages, options)
          }

          const latestToolMessage = [...messages].reverse().find((message) => message.role === 'tool')
          if (latestToolMessage?.content.includes('New York to Los Angeles') || latestToolMessage?.content.includes('"to":"Los Angeles"')) {
            return createMockProvider({ responses: 'Return booked successfully.' }).stream(messages, options)
          }
          if (latestToolMessage) {
            return createMockProvider({ responses: 'Outbound booked successfully.' }).stream(messages, options)
          }

          return createMockProvider({ responses: 'No booking needed' }).stream(messages, options)
        },
      })

      const setup = function* setup() {
        yield* setupInMemoryDurableStreams<string>()
        yield* FoldSessionBufferStoreContext.set(foldSessionBufferStore)
        yield* setupMockModelProvider(provider)
        yield* PluginRegistryContext.set(pluginRegistry)
        yield* McpToolRegistryContext.set(mcpToolRegistry)
        yield* PluginSessionManagerContext.set(pluginSessionManager)
        const localBookFlightTool = bookFlightTool as LocalSessionTool
        yield* ToolInventoryContext.set(
          createToolInventory([createToolInventoryEntry(localBookFlightTool)]),
        )
        yield* installLocalToolRuntime({
          tools: [localBookFlightTool],
          registry: toolSessionRegistry,
          samplingProvider,
        })
      }

      const handler = createChatHandler({ setup, maxToolIterations: 5 })
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const { signal, ...restInit } = init ?? {}
        const rawUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const url =
          rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
            ? rawUrl
            : `http://localhost${rawUrl}`
        return handler(new Request(url, restInit))
      }

      try {
        // Intentionally omit conversationId: the session must adopt the
        // server-minted X-Conversation-Id so fold history persists.
        const { state, dispatch } = yield* createChatSession({
          baseUrl: 'http://localhost/chat',
          plugins: [bookFlightPlugin],
        })
        let currentState = initialChatState

        yield* spawn(function* () {
          for (const nextState of yield* each(state)) {
            currentState = nextState
            yield* each.next()
          }
        })

        yield* sleep(0)
        dispatch({ type: 'send', content: 'Book a flight from Los Angeles to New York' })

        // Outbound: pickFlight → pickSeat
        let stateWithElicit = yield* waitForState(
          'outbound pickFlight',
          () => currentState,
          (candidate) => !candidate.isStreaming && findPendingElicit(candidate, 'pickFlight') !== null,
        )
        let pending = findPendingElicit(stateWithElicit, 'pickFlight')
        expect(pending).not.toBeNull()
        dispatch({
          type: 'elicit_response',
          sessionId: pending!.sessionId,
          callId: pending!.callId,
          elicitId: pending!.elicitId,
          result: { action: 'accept', content: { flightId: 'FL001' } },
        })

        stateWithElicit = yield* waitForState(
          'outbound pickSeat',
          () => currentState,
          (candidate) => !candidate.isStreaming && findPendingElicit(candidate, 'pickSeat') !== null,
        )
        pending = findPendingElicit(stateWithElicit, 'pickSeat')
        expect(pending).not.toBeNull()
        dispatch({
          type: 'elicit_response',
          sessionId: pending!.sessionId,
          callId: pending!.callId,
          elicitId: pending!.elicitId,
          result: { action: 'accept', content: { row: 2, seat: 'A' } },
        })

        yield* waitForState(
          'outbound confirmation',
          () => currentState,
          (candidate) =>
            !candidate.isStreaming &&
            candidate.messages.some(
              (message) =>
                message.role === 'assistant' && /Outbound booked|Successfully booked|TKT-/i.test(message.content),
            ),
        )

        // Follow-up does NOT restate cities — history must carry the route.
        dispatch({ type: 'send', content: 'ok, book the return flight' })
        yield* sleep(500)

        const returnRequest = providerMessages.find((messages) => {
          const last = messages[messages.length - 1]
          return last?.role === 'user' && /book the return flight/i.test(last.content)
        })

        expect(returnRequest).toBeDefined()
        expect(transcriptHasOutboundBooking(returnRequest!)).toBe(true)

        // Wait for return flow to start (or fail honestly if history is missing).
        stateWithElicit = yield* waitForState(
          'return pickFlight from history',
          () => currentState,
          (candidate) =>
            !candidate.isStreaming &&
            (findPendingElicit(candidate, 'pickFlight') !== null ||
              candidate.messages.some(
                (message) =>
                  message.role === 'assistant' &&
                  /need origin and destination|I need origin and destination/i.test(message.content),
              )),
        )

        const returnElicit = findPendingElicit(stateWithElicit, 'pickFlight')
        expect(
          returnElicit,
          'return booking should start from history without restating cities',
        ).not.toBeNull()

        // Prove the follow-up sample had enough history to infer the reverse route.
        expect(returnInference.length).toBeGreaterThan(0)
        expect(returnInference[0]?.canInferReturn).toBe(true)
        expect(returnInference[0]?.args).toEqual({
          from: 'New York',
          destination: 'Los Angeles',
        })
      } finally {
        globalThis.fetch = originalFetch
        yield* call(() => destroyServerScope())
      }
    })
  }, 60_000)
})
