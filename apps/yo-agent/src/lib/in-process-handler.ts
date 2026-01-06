/**
 * In-Process Handler Adapter
 *
 * Creates a fetch-like interface that calls the chat handler directly
 * in-process, without going over HTTP. This allows yo-agent to use
 * the same hooks and patterns as yo-chat while running in a single process.
 *
 * ## Architecture
 *
 * Instead of:
 *   React Hook → fetch() → HTTP → Express → Handler
 *
 * We have:
 *   React Hook → inProcessFetch() → Handler (direct call)
 *
 * The handler returns a streaming Response, which we pass back to the hook.
 */

import { createChatHandler } from '@sweatpants/framework/handler'
import type { InitializerContext, IsomorphicTool } from '@sweatpants/framework/handler'
import { ollamaProvider, openaiProvider, ProviderContext, ToolRegistryContext, MaxIterationsContext } from '@sweatpants/framework/chat'
import { setupInMemoryDurableStreams } from '@sweatpants/framework/chat/durable-streams'
import type { Operation } from 'effection'

// Re-export for convenience
export type { IsomorphicTool }

/**
 * Configuration for creating an in-process handler.
 */
export interface InProcessHandlerConfig {
  /** Provider to use: 'ollama' | 'openai' */
  provider: 'ollama' | 'openai'
  
  /** Tools to register */
  tools: IsomorphicTool[]
  
  /** Max tool iterations (default: 10) */
  maxIterations?: number
}

/**
 * Create an in-process chat handler.
 *
 * Returns a fetch-like function that can be used with the framework's hooks.
 */
export function createInProcessHandler(config: InProcessHandlerConfig) {
  const { provider: providerName, tools, maxIterations = 10 } = config

  // Create initializer hooks (same pattern as yo-chat)
  const setupDurableStreams = function* (_ctx: InitializerContext): Operation<void> {
    yield* setupInMemoryDurableStreams<string>()
  }

  const setupProvider = function* (_ctx: InitializerContext): Operation<void> {
    const providerMap = {
      ollama: ollamaProvider,
      openai: openaiProvider,
    }

    const selectedProvider = providerMap[providerName]
    if (!selectedProvider) {
      throw new Error(`Unknown provider: ${providerName}`)
    }

    yield* ProviderContext.set(selectedProvider)
  }

  const setupTools = function* (_ctx: InitializerContext): Operation<void> {
    yield* ToolRegistryContext.set(tools)
  }

  const setupMaxIterations = function* (_ctx: InitializerContext): Operation<void> {
    yield* MaxIterationsContext.set(maxIterations)
  }

  // Create the handler
  const handler = createChatHandler({
    initializerHooks: [setupDurableStreams, setupProvider, setupTools, setupMaxIterations],
    maxToolIterations: maxIterations,
  })

  /**
   * Fetch-like function that calls the handler in-process.
   *
   * This is the adapter that makes the framework's hooks work
   * without an HTTP layer.
   */
  async function inProcessFetch(
    input: string | Request,
    init?: RequestInit
  ): Promise<Response> {
    // Build the request - preserve the original if it's already a Request
    const request = typeof input === 'string' 
      ? new Request(input, init)
      : input

    const url = request.url

    // Check if this is a chat request
    if (url.endsWith('/api/chat') && request.method === 'POST') {
      return handler(request)
    }

    // For other requests, return a 404
    return new Response('Not found', { status: 404 })
  }

  return inProcessFetch
}

/**
 * Create a base URL for in-process requests.
 *
 * The actual URL doesn't matter since we're not going over HTTP,
 * but the hooks expect a valid URL format.
 */
export const IN_PROCESS_BASE_URL = 'http://localhost:0'
