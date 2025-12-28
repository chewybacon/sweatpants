/**
 * @tanstack/framework/react/chat
 *
 * Streaming chat rendering with progressive enhancement.
 *
 * ## Recommended API (Plugin-based)
 *
 * ```typescript
 * import { useChat } from '@tanstack/framework/react/chat'
 * import { markdownPlugin, shikiPlugin } from '@tanstack/framework/react/chat/plugins'
 *
 * function Chat() {
 *   const { messages, send, isStreaming } = useChat({
 *     plugins: [markdownPlugin, shikiPlugin]
 *   })
 *   // ...
 * }
 * ```
 *
 * ## Available Plugins
 *
 * - `markdownPlugin` - Parse markdown to HTML
 * - `shikiPlugin` - Progressive syntax highlighting
 * - `mermaidPlugin` - Progressive diagram rendering
 * - `mathPlugin` - KaTeX math rendering
 */

// --- Primary API ---
export * from './useChat'
export * from './useChatSession'
export * from './ChatProvider'

// --- Plugin System (Recommended) ---
export * from './plugins'

// --- Types ---
export * from './types'

// --- Core Infrastructure ---
export * from './core'
export * from './settlers'
export * from './processors'
export * from './processor-chain'

// --- Session & Streaming ---
export * from './session'
export * from './streamChatOnce'
export * from './transforms'
export * from './contexts'

// --- Additional Hooks ---
export * from './usePersonas'

// --- Legacy/Deprecated (kept for backward compatibility) ---
// tripleBuffer re-exports from core with deprecation notice
export * from './tripleBuffer'
export * from './dualBuffer'
// @deprecated - use plugins instead
export * from './processor-orchestrator'

// --- Namespaced Modules ---
// Shiki module - namespaced to avoid conflicts with settlers
export * as shiki from './shiki'
// Mermaid module - progressive diagram rendering
export * as mermaid from './mermaid'
