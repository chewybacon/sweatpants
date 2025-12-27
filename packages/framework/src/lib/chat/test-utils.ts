import type { Operation } from 'effection'
import { ProviderContext, ToolRegistryContext, PersonaResolverContext, MaxIterationsContext } from './providers/contexts'
import type { ChatProvider } from './providers/types'
import type { IsomorphicTool, PersonaResolver } from '../../handler/types'

/**
 * Test utilities for setting up DI contexts in unit tests
 */
export interface ChatTestContexts {
  provider?: ChatProvider
  tools?: IsomorphicTool[]
  personaResolver?: PersonaResolver
  maxIterations?: number
}

/**
 * Helper to set up DI contexts for testing
 * Wraps a test function with context setup
 */
export function* withChatContexts<T>(
  contexts: ChatTestContexts,
  testFn: () => Operation<T>
): Operation<T> {
  if (contexts.provider) {
    yield* ProviderContext.set(contexts.provider)
  }
  if (contexts.tools) {
    yield* ToolRegistryContext.set(contexts.tools)
  }
  if (contexts.personaResolver) {
    yield* PersonaResolverContext.set(contexts.personaResolver)
  }
  if (contexts.maxIterations !== undefined) {
    yield* MaxIterationsContext.set(contexts.maxIterations)
  }

  return yield* testFn()
}

/**
 * Helper to create a mock provider for testing
 */
export function createMockProvider(overrides: Partial<ChatProvider> = {}): ChatProvider {
  return {
    name: 'mock',
    stream: function*() {
      return { text: 'mock response', toolCalls: [] }
    },
    ...overrides,
  } as ChatProvider
}