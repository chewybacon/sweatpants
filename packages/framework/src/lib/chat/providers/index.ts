import type { ChatProvider } from './types'
import { ollamaProvider } from './ollama'
import { openaiProvider } from './openai'

export type { ChatProvider, ChatStreamOptions, ProviderCapabilities } from './types'
export { ollamaProvider } from './ollama'
export { openaiProvider } from './openai'

/**
 * Get the chat provider based on environment configuration.
 * Provider is selected via CHAT_PROVIDER env var (default: 'ollama').
 */
export function getChatProvider(): ChatProvider {
  const provider = process.env["CHAT_PROVIDER"]
  switch (provider) {
    case 'openai':
      return openaiProvider
    case 'ollama':
    default:
      return ollamaProvider
  }
}
