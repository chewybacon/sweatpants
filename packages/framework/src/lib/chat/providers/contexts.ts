import { createContext } from 'effection'

import type { ChatStreamOptions, ChatProvider } from './types'

export const ChatStreamConfigContext = createContext<ChatStreamOptions>('ChatStreamOptions')
export const ChatApiKeyContext = createContext<string>('ChatApiKeyContext')

// Provider registry for dependency injection
export interface ProviderRegistry {
  ollama: ChatProvider
  openai: ChatProvider
}

export const ProviderRegistryContext = createContext<ProviderRegistry>('ProviderRegistry')
