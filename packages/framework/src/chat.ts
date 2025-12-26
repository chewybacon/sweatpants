/**
 * Chat API
 *
 * Provides chat provider and persona resolution functionality.
 * Re-exports with proper typing.
 */

// Re-export with explicit typing to avoid conflicts
export { getChatProvider } from './lib/chat/providers/index'
export { resolvePersona } from './lib/chat/personas/index'