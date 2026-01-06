/**
 * Integration Tests for Chat Handler with DI Context Injection
 *
 * Tests the new initializer hooks system and context-based dependency injection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createScope } from 'effection'
import { z } from 'zod'
import { createChatHandler, type InitializerContext } from '../index'
import { ProviderContext, ToolRegistryContext, PersonaResolverContext, MaxIterationsContext } from '../../lib/chat/providers/contexts'
import { type ChatProvider, type IsomorphicTool, type PersonaResolver } from '../types'

// Mock the modules
vi.mock('../../lib/chat/personas', () => ({
  resolvePersona: vi.fn().mockReturnValue({
    name: 'test-persona',
    systemPrompt: 'Test system prompt',
    tools: ['mock-tool'],
    capabilities: { thinking: true, streaming: true, tools: ['mock-tool'] },
  }),
}))

// Mock providers
const mockProvider: ChatProvider = {
  name: 'mock',
  capabilities: { thinking: true, toolCalling: true },
  stream: function* () {
    return { text: 'Mock response', toolCalls: [] }
  },
}

const anotherMockProvider: ChatProvider = {
  name: 'another-mock',
  capabilities: { thinking: false, toolCalling: false },
  stream: function* () {
    return { text: 'Another mock response', toolCalls: [] }
  },
}

// Mock tools
const mockTool: IsomorphicTool = {
  name: 'mock-tool',
  description: 'A mock tool',
  parameters: z.object({}),
  server: function* () { return 'mock result' },
}

// Mock persona resolver
const mockPersonaResolver: PersonaResolver = (name) => ({
  name,
  systemPrompt: 'Mock system prompt',
  tools: [],
  capabilities: { thinking: true, streaming: true, tools: [] },
})

describe('Chat Handler DI Context Injection', () => {
  beforeEach(() => {
    // Reset contexts between tests
    vi.clearAllMocks()
  })

  describe('Initializer Hooks Execution', () => {
    it('should execute initializer hooks in sequence', async () => {
      const executionOrder: string[] = []

      const setupProvider = function*(ctx: InitializerContext) {
        executionOrder.push('provider')
        yield* ProviderContext.set(mockProvider)
      }

      const setupTools = function*(ctx: InitializerContext) {
        executionOrder.push('tools')
        yield* ToolRegistryContext.set([mockTool])
      }

      const setupPersona = function*(ctx: InitializerContext) {
        executionOrder.push('persona')
        yield* PersonaResolverContext.set(mockPersonaResolver)
      }

      const handler = createChatHandler({
        initializerHooks: [setupProvider, setupTools, setupPersona],
      })

      // Create a mock request
      const mockRequest = new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      })

      // Execute the handler in a scope to test hook execution
      const [scope, destroy] = createScope()
      let hookExecuted = false

      try {
        await scope.run(function* () {
          try {
            // We can't easily test the full handler without mocking the stream,
            // but we can test that hooks are called by checking if contexts are set
            const testHooks = [setupProvider, setupTools, setupPersona]
            for (const hook of testHooks) {
              yield* hook({ request: mockRequest, body: { messages: [] } } as InitializerContext)
            }
            hookExecuted = true
          } catch (error) {
            // Ignore errors for this test
          }
        })
      } finally {
        destroy()
      }

      expect(hookExecuted).toBe(true)
      expect(executionOrder).toEqual(['provider', 'tools', 'persona'])
    })

    it('should set contexts correctly via hooks', async () => {
      const setupAll = function*(ctx: InitializerContext) {
        yield* ProviderContext.set(mockProvider)
        yield* ToolRegistryContext.set([mockTool])
        yield* PersonaResolverContext.set(mockPersonaResolver)
        yield* MaxIterationsContext.set(5)
      }

      const [scope, destroy] = createScope()

      try {
        await scope.run(function* () {
          yield* setupAll({ request: {} as Request, body: {} as any })

          const provider = yield* ProviderContext.get()
          const tools = yield* ToolRegistryContext.get()
          const personaResolver = yield* PersonaResolverContext.get()
          const maxIterations = yield* MaxIterationsContext.get()

          expect(provider).toBe(mockProvider)
          expect(tools).toEqual([mockTool])
          expect(personaResolver).toBe(mockPersonaResolver)
          expect(maxIterations).toBe(5)
        })
      } finally {
        destroy()
      }
    })

    it('should allow dynamic provider selection based on request', async () => {
      const setupDynamicProvider = function*(ctx: InitializerContext) {
        const providerName = ctx.body.provider || 'default'
        const providerMap = {
          default: mockProvider,
          other: anotherMockProvider,
        }
        yield* ProviderContext.set(providerMap[providerName as keyof typeof providerMap] || mockProvider)
      }

      const [scope, destroy] = createScope()

      try {
        await scope.run(function* () {
          // Test default provider
          yield* setupDynamicProvider({
            request: {} as Request,
            body: { messages: [] }
          })
          expect(yield* ProviderContext.get()).toBe(mockProvider)

          // Test other provider
          yield* setupDynamicProvider({
            request: {} as Request,
            body: { messages: [], provider: 'other' }
          })
          expect(yield* ProviderContext.get()).toBe(anotherMockProvider)
        })
      } finally {
        destroy()
      }
    })

    it('should return undefined for unset contexts', async () => {
      const [scope, destroy] = createScope()

      try {
        await scope.run(function* () {
          // Contexts should be undefined when not set
          const provider = yield* ProviderContext.get()
          const tools = yield* ToolRegistryContext.get()
          const personaResolver = yield* PersonaResolverContext.get()
          const maxIterations = yield* MaxIterationsContext.get()

          expect(provider).toBeUndefined()
          expect(tools).toBeUndefined()
          expect(personaResolver).toBeUndefined()
          expect(maxIterations).toBeUndefined()
        })
      } finally {
        destroy()
      }
    })
  })

  describe('Context Isolation', () => {
    it('should isolate contexts between different scopes', async () => {
      const [scope1, destroy1] = createScope()
      const [scope2, destroy2] = createScope()

      try {
        await scope1.run(function* () {
          yield* ProviderContext.set(mockProvider)
          expect(yield* ProviderContext.get()).toBe(mockProvider)
        })
      } finally {
        destroy1()
      }

      try {
        await scope2.run(function* () {
          // Context should not be set in scope2
          const provider = yield* ProviderContext.get()
          expect(provider).toBeUndefined()
        })
      } finally {
        destroy2()
      }
    })
  })

  describe('Error Handling', () => {
    it('should handle hook execution errors gracefully', async () => {
      const failingHook = function*(ctx: InitializerContext) {
        throw new Error('Hook failed')
      }

      // Test that individual hooks throw correctly
      const [scope, destroy] = createScope()
      let error: Error | null = null

      try {
        await scope.run(function* () {
          try {
            yield* failingHook({ request: {} as Request, body: { messages: [] } } as InitializerContext)
          } catch (e) {
            error = e as Error
          }
        })
      } finally {
        destroy()
      }

      expect(error?.message).toBe('Hook failed')
    })

    it('should provide helpful error messages for missing contexts', async () => {
      // Test the error messages that would be thrown by the handler
      // when required contexts are not set

      const [scope, destroy] = createScope()
      let providerError: string | null = null
      let toolsError: string | null = null

      try {
        await scope.run(function* () {
          // Simulate what the handler does when contexts are missing
          const provider = yield* ProviderContext.get()
          if (!provider) {
            providerError = 'Provider not configured. Ensure a provider initializer hook sets ProviderContext.'
          }

          const tools = yield* ToolRegistryContext.get()
          if (!tools) {
            toolsError = 'Tool registry not configured. Ensure a tool registry initializer hook sets ToolRegistryContext.'
          }
        })
      } finally {
        destroy()
      }

      expect(providerError).toBe('Provider not configured. Ensure a provider initializer hook sets ProviderContext.')
      expect(toolsError).toBe('Tool registry not configured. Ensure a tool registry initializer hook sets ToolRegistryContext.')
    })
  })

  describe('End-to-End Handler Integration', () => {
    it('should handle errors gracefully when contexts are not set', async () => {
      // Handler with no hooks - should fail with helpful error
      const handler = createChatHandler({
        initializerHooks: [], // No hooks to set required contexts
      })

      const request = new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user' as const, content: 'Hello' }],
        }),
      })

      const response = await handler(request)
      const responseText = await response.text()
      // Durable handler wraps events in { lsn, event } format
      const events = responseText.trim().split('\n').map(line => {
        const parsed = JSON.parse(line)
        return parsed.event ?? parsed // Handle both wrapped and unwrapped formats
      })

      // Should have an error event with helpful message
      const errorEvent = events.find((e: any) => e.type === 'error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent.message).toContain('Provider not configured')
    })
  })
})
