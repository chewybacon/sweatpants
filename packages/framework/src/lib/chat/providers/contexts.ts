import { createContext } from 'effection'

import type { ChatStreamOptions, ChatProvider } from './types'
import type { IsomorphicTool } from '../../../handler/types'
import type { PersonaResolver } from '../../../handler/types'

export const ChatStreamConfigContext = createContext<ChatStreamOptions>('ChatStreamOptions')
export const ChatApiKeyContext = createContext<string>('ChatApiKeyContext')

// Provider registry for dependency injection
export interface ProviderRegistry {
  ollama: ChatProvider
  openai: ChatProvider
}

export const ProviderRegistryContext = createContext<ProviderRegistry>('ProviderRegistry')

// DI contexts for hook-based configuration
export const ProviderContext = createContext<ChatProvider>('Provider')
export const ToolRegistryContext = createContext<IsomorphicTool[]>('ToolRegistry')
export const PersonaResolverContext = createContext<PersonaResolver>('PersonaResolver')
export const MaxIterationsContext = createContext<number>('MaxIterations')
