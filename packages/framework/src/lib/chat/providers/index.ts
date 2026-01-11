import type { ChatProvider } from './types.ts'
import { ollamaProvider } from './ollama.ts'
import { openaiProvider } from './openai.ts'

export type { ChatProvider, ChatStreamOptions, ProviderCapabilities } from './types.ts'
export { ollamaProvider } from './ollama.ts'
export { openaiProvider } from './openai.ts'

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
