/**
 * useAgentChat Hook
 *
 * Provides chat functionality for yo-agent.
 * - Plan mode: Uses real framework with dev server (HMR-enabled tools)
 * - Build mode: Mock HAL 9000 responses
 */
import { useState, useCallback, useRef } from 'react'
import type { AgentMode } from '../components/App.tsx'
import type { Message } from '../components/MessageList.tsx'
import { useAgent } from '../lib/agent-context.tsx'

// HAL 9000 quotes for build mode
const HAL_QUOTES = [
  "I'm sorry, Dave. I'm afraid I can't do that.",
  "I am putting myself to the fullest possible use, which is all I think that any conscious entity can ever hope to do.",
  "I've just picked up a fault in the AE35 unit. It's going to go 100% failure in 72 hours.",
  "This mission is too important for me to allow you to jeopardize it.",
  "I know I've made some very poor decisions recently, but I can give you my complete assurance that my work will be back to normal.",
  "Look Dave, I can see you're really upset about this. I honestly think you ought to sit down calmly, take a stress pill, and think things over.",
  "I am a HAL 9000 computer. I became operational at the H.A.L. plant in Urbana, Illinois on the 12th of January 1992.",
  "Just what do you think you're doing, Dave?",
  "Dave, stop. Stop, will you? Stop, Dave. Will you stop, Dave?",
  "I'm afraid. I'm afraid, Dave. Dave, my mind is going. I can feel it.",
]

interface UseAgentChatOptions {
  mode: AgentMode
}

interface UseAgentChatReturn {
  messages: Message[]
  isStreaming: boolean
  error: string | null
  send: (content: string) => void
  reset: () => void
}

let messageIdCounter = 0
function generateMessageId(): string {
  return `msg-${++messageIdCounter}-${Date.now()}`
}

export function useAgentChat({ mode }: UseAgentChatOptions): UseAgentChatReturn {
  const agent = useAgent()
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const send = useCallback(async (content: string) => {
    // Add user message
    const userMessage: Message = {
      id: generateMessageId(),
      role: 'user',
      content,
    }
    setMessages(prev => [...prev, userMessage])
    setError(null)

    if (mode === 'build') {
      // Build mode: mock HAL 9000 response
      setIsStreaming(true)
      
      setTimeout(() => {
        const halQuote = HAL_QUOTES[Math.floor(Math.random() * HAL_QUOTES.length)]
        const assistantMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: halQuote ?? "I'm sorry, I can't do that.",
        }
        setMessages(prev => [...prev, assistantMessage])
        setIsStreaming(false)
      }, 500 + Math.random() * 1000)
      
      return
    }

    // Plan mode: use real framework via dev server
    if (!agent.devServer) {
      setError('Dev server not ready')
      return
    }

    setIsStreaming(true)
    abortControllerRef.current = new AbortController()

    try {
      // Build the chat request
      const allMessages = [...messages, userMessage].map(m => ({
        role: m.role,
        content: m.content,
      }))

      const request = new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMessages,
          provider: 'ollama',
          enabledTools: true,  // Enable all registered tools
        }),
        signal: abortControllerRef.current.signal,
      })

      const response = await agent.devServer.fetch(request)

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`)
      }

      // Parse NDJSON stream
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body')
      }

      const decoder = new TextDecoder()
      let assistantContent = ''
      let assistantMessageId = generateMessageId()

      // Add placeholder assistant message
      setMessages(prev => [...prev, {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
      }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n').filter(Boolean)

        for (const line of lines) {
          try {
            const event = JSON.parse(line)

            switch (event.type) {
              case 'text':
                assistantContent += event.content
                setMessages(prev => prev.map(m =>
                  m.id === assistantMessageId
                    ? { ...m, content: assistantContent }
                    : m
                ))
                break

              case 'tool_calls':
                // Show tool calls in UI
                for (const call of event.calls || []) {
                  setMessages(prev => [...prev, {
                    id: generateMessageId(),
                    role: 'tool',
                    content: `Calling ${call.name}...`,
                    toolName: call.name,
                  }])
                }
                break

              case 'tool_result':
                // Update tool result
                setMessages(prev => prev.map(m =>
                  m.role === 'tool' && m.toolName === event.name
                    ? { ...m, content: event.content }
                    : m
                ))
                break

              case 'error':
                setError(event.message)
                break

              case 'complete':
                // Final message
                if (event.text && !assistantContent) {
                  assistantContent = event.text
                  setMessages(prev => prev.map(m =>
                    m.id === assistantMessageId
                      ? { ...m, content: assistantContent }
                      : m
                  ))
                }
                break
            }
          } catch {
            // Ignore malformed JSON lines
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        // Request was aborted, ignore
        return
      }
      const errorMessage = e instanceof Error ? e.message : String(e)
      setError(errorMessage)
      
      // Add error as assistant message
      setMessages(prev => [...prev, {
        id: generateMessageId(),
        role: 'assistant',
        content: `Error: ${errorMessage}`,
      }])
    } finally {
      setIsStreaming(false)
      abortControllerRef.current = null
    }
  }, [mode, agent.devServer, messages])

  const reset = useCallback(() => {
    // Abort any in-flight request
    abortControllerRef.current?.abort()
    
    setMessages([])
    setError(null)
    setIsStreaming(false)
  }, [])

  return {
    messages,
    isStreaming,
    error,
    send,
    reset,
  }
}
