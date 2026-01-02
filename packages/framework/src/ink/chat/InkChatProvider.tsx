/**
 * InkChatProvider.tsx
 *
 * Context provider for Ink chat applications.
 * Provides configuration for chat hooks (baseUrl, customFetch, etc.)
 */
import { createContext, useContext, type ReactNode } from 'react'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Custom fetch function type.
 * This allows using in-process handlers instead of HTTP.
 */
export type CustomFetchFn = (request: Request) => Promise<Response>

/**
 * Configuration for Ink chat.
 */
export interface InkChatConfig {
  /**
   * Base URL for the chat API.
   * Used when making HTTP requests to a chat server.
   * @default '/api/chat'
   */
  baseUrl?: string

  /**
   * Custom fetch function.
   * When provided, this is used instead of the standard fetch.
   * Useful for in-process handlers (like dev servers with HMR).
   */
  customFetch?: CustomFetchFn

  /**
   * Provider name (e.g., 'ollama', 'openai').
   * If set, this is sent in the request body.
   */
  provider?: string
}

/**
 * Internal config with defaults applied.
 */
export interface ResolvedInkChatConfig {
  baseUrl: string
  customFetch?: CustomFetchFn
  provider?: string
}

// =============================================================================
// CONTEXT
// =============================================================================

const defaultConfig: ResolvedInkChatConfig = {
  baseUrl: '/api/chat',
}

const InkChatContext = createContext<ResolvedInkChatConfig>(defaultConfig)

// =============================================================================
// PROVIDER
// =============================================================================

export interface InkChatProviderProps {
  children: ReactNode
  /**
   * Base URL for the chat API.
   */
  baseUrl?: string
  /**
   * Custom fetch function for in-process handlers.
   */
  customFetch?: CustomFetchFn
  /**
   * Provider name to use.
   */
  provider?: string
}

/**
 * Provider for Ink chat configuration.
 *
 * @example
 * ```tsx
 * // HTTP-based chat
 * <InkChatProvider baseUrl="http://localhost:8000/api/chat">
 *   <App />
 * </InkChatProvider>
 *
 * // In-process handler (like yo-agent)
 * <InkChatProvider customFetch={(req) => devServer.fetch(req)}>
 *   <App />
 * </InkChatProvider>
 * ```
 */
export function InkChatProvider({
  children,
  baseUrl = defaultConfig.baseUrl,
  customFetch,
  provider,
}: InkChatProviderProps) {
  const value: ResolvedInkChatConfig = {
    baseUrl,
    ...(customFetch && { customFetch }),
    ...(provider && { provider }),
  }

  return (
    <InkChatContext.Provider value={value}>
      {children}
    </InkChatContext.Provider>
  )
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Get the current Ink chat configuration.
 */
export function useInkChatConfig(): ResolvedInkChatConfig {
  return useContext(InkChatContext)
}
