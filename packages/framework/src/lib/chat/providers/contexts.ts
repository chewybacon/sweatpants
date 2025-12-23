import { createContext } from 'effection'

import type { ChatStreamOptions } from './types'

export const ChatStreamConfigContext = createContext<ChatStreamOptions>('ChatStreamOptions')
export const ChatApiKeyContext = createContext<string>('ChatApiKeyContext')
