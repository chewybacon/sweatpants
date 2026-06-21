/**
 * ChatProvider.tsx
 *
 * React Context for chat configuration.
 * 
 * Provides a centralized way to configure the chat hooks (useChatSession, usePersonas)
 * without passing props through every component.
 *
 * @example
 * ```tsx
 * // App root - configure once
 * import { ChatProvider } from '@/demo/effection/chat'
 *
 * function App() {
 *   return (
 *     <ChatProvider baseUrl="https://api.example.com/chat">
 *       <MyChat />
 *     </ChatProvider>
 *   )
 * }
 *
 * // Any child component - hooks use context automatically
 * function MyChat() {
 *   const { state, send } = useChatSession()  // uses baseUrl from context
 *   const { personas } = usePersonas()         // uses baseUrl from context
 *   // ...
 * }
 *
 * // Override per-hook if needed
 * function SpecialChat() {
 *   const { state, send } = useChatSession({ 
 *     baseUrl: 'http://localhost:4000/api/chat'  // overrides context
 *   })
 * }
 * ```
 */
import { createContext, useContext, type ReactNode } from 'react'

/**
 * Configuration for the chat context.
 */
export interface ChatConfig {
  /**
   * Base URL for the chat API.
   * 
   * All hooks will use this URL unless overridden per-hook.
   * 
   * @default '/api/chat'
   */
  baseUrl: string
}

const defaultConfig: ChatConfig = {
  baseUrl: '/api/chat',
}

const ChatContext = createContext<ChatConfig>(defaultConfig)

/**
 * Props for the ChatProvider component.
 */
export interface ChatProviderProps {
  children: ReactNode
  /**
   * Base URL for the chat API.
   * 
   * @default '/api/chat'
   */
  baseUrl?: string
}

/**
 * Provider component for chat configuration.
 * 
 * Wrap your app (or a subtree) with this to configure all chat hooks.
 * 
 * @example
 * ```tsx
 * <ChatProvider baseUrl="https://api.example.com/chat">
 *   <App />
 * </ChatProvider>
 * ```
 */
export function ChatProvider({ children, baseUrl = '/api/chat' }: ChatProviderProps) {
  const config: ChatConfig = { baseUrl }
  
  return (
    <ChatContext.Provider value={config}>
      {children}
    </ChatContext.Provider>
  )
}

/**
 * Hook to access the chat configuration from context.
 * 
 * Used internally by useChatSession and usePersonas.
 * Can also be used directly if you need access to the config.
 * 
 * @returns The current chat configuration
 */
export function useChatConfig(): ChatConfig {
  return useContext(ChatContext)
}
