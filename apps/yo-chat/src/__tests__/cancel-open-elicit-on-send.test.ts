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
import { pickCard, pickCardPlugin } from '../tools/pick-card'

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

describe('cancel open elicits on free-form send', () => {
  it('lets a free-form follow-up proceed while a plugin interrupt is still open', async () => {
    await run(function* () {
      const pluginRegistry = createPluginRegistryFrom([pickCardPlugin.client as any])
      const mcpToolRegistry = createSingleToolMcpRegistry(pickCard)

      const [serverScope, destroyServerScope] = createScope()
      const ready = createChannel<
        { registry: ToolSessionRegistry; manager: PluginSessionManager; samplingProvider: any },
        void
      >()

      serverScope.run(function* () {
        const store = createInMemoryToolSessionStore()
        const samplingProvider = {
          *sample() {
            return { text: 'unused', model: 'mock', stopReason: 'endTurn' as const }
          },
        }
        const registry = yield* createToolSessionRegistry(store, { samplingProvider })
        const manager = yield* createPluginSessionManager({ registry })
        yield* ready.send({ registry, manager, samplingProvider })
        yield* suspend()
      })

      const readySub = yield* ready
      const readyResult = yield* readySub.next()
      if (readyResult.done) throw new Error('setup channel closed')
      const {
        registry: toolSessionRegistry,
        manager: pluginSessionManager,
        samplingProvider,
      } = readyResult.value

      const providerMessages: string[][] = []
      const foldSessionBufferStore = createSessionContractInMemoryStore()
      const provider = createMockProvider({
        customStream: (messages, options) => {
          providerMessages.push(messages.map((message) => `${message.role}:${message.content}`))
          const last = messages[messages.length - 1]
          if (last?.role === 'user' && /draw a card/i.test(last.content)) {
            return createMockProvider({
              responses: 'Calling pick_card',
              toolCalls: [
                {
                  id: 'pick-card-call-1',
                  name: pickCard.name,
                  arguments: { count: 3 },
                },
              ],
            }).stream(messages, options)
          }
          if (last?.role === 'user' && /why did you launch/i.test(last.content)) {
            return createMockProvider({
              responses: 'I launched a card picker earlier; ask if you still want to pick.',
            }).stream(messages, options)
          }
          return createMockProvider({ responses: 'ok' }).stream(messages, options)
        },
      })

      const setup = function* setup() {
        yield* setupInMemoryDurableStreams<string>()
        yield* FoldSessionBufferStoreContext.set(foldSessionBufferStore)
        yield* setupMockModelProvider(provider)
        yield* PluginRegistryContext.set(pluginRegistry)
        yield* McpToolRegistryContext.set(mcpToolRegistry)
        yield* PluginSessionManagerContext.set(pluginSessionManager)
        const localPickCardTool = pickCard as LocalSessionTool
        yield* ToolInventoryContext.set(
          createToolInventory([createToolInventoryEntry(localPickCardTool)]),
        )
        yield* installLocalToolRuntime({
          tools: [localPickCardTool],
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
        const { state, dispatch } = yield* createChatSession({
          baseUrl: 'http://localhost/chat',
          plugins: [pickCardPlugin],
        })
        let currentState = initialChatState
        yield* spawn(function* () {
          for (const nextState of yield* each(state)) {
            currentState = nextState
            yield* each.next()
          }
        })
        yield* sleep(0)

        dispatch({ type: 'send', content: 'draw a card from 3 cards' })
        yield* waitForState(
          'pickCard interrupt open',
          () => currentState,
          (candidate) => !candidate.isStreaming && findPendingElicit(candidate, 'pickCard') !== null,
        )

        // Free-form send while the interrupt is still open. This used to hit
        // "Open interrupts require resume[]" because cancel was not sent.
        dispatch({ type: 'send', content: 'why did you launch a game?' })

        yield* waitForState(
          'follow-up answered without open-interrupt error',
          () => currentState,
          (candidate) =>
            !candidate.isStreaming &&
            candidate.messages.some(
              (message) =>
                message.role === 'assistant' &&
                /launched a card picker|ask if you still want/i.test(message.content),
            ) &&
            !candidate.error,
        )

        expect(currentState.error).toBeNull()
        expect(
          currentState.messages.some((message) =>
            /Open interrupts require resume/i.test(message.content ?? ''),
          ),
        ).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
        yield* call(() => destroyServerScope())
      }
    })
  }, 60_000)
})
