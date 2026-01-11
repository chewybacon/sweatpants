/**
 * ChatDemo - Minimal Test Harness Component
 *
 * A minimal chat component that uses the useChat hook and renders
 * with data-testid attributes for E2E testing with Interactors.
 *
 * This is NOT meant to be a production UI - it's designed to be:
 * - Minimal: Only the essential elements
 * - Testable: All elements have data-testid attributes
 * - Flexible: Can be configured with different pipeline/tools
 *
 * Expected DOM structure matches the Interactors:
 * - ChatSession: [data-testid="chat-session"]
 * - Message: [data-testid="message"]
 * - ToolCall: [data-testid="tool-call"]
 */
import React, { useState } from 'react'
import { useChat, type ChatMessage, type ChatToolCall, type UseChatOptions } from '../../src/react/chat/useChat.ts'

// Props for the ChatDemo component
export interface ChatDemoProps extends Omit<UseChatOptions, 'onError'> {
  /** Session ID for identifying this chat session */
  sessionId?: string
  /** Initial messages to display */
  initialMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Base URL for the chat API (defaults to /api/chat) */
  baseUrl?: string
}

/**
 * Renders a tool call with its emissions.
 */
function ToolCallBlock({ toolCall }: { toolCall: ChatToolCall }) {
  return (
    <div
      data-testid="tool-call"
      data-tool-name={toolCall.name}
      data-tool-call-id={toolCall.id}
      data-tool-state={toolCall.state}
    >
      <div data-testid="tool-name">{toolCall.name}</div>
      <div data-testid="tool-args">{JSON.stringify(toolCall.arguments)}</div>

      {/* Emissions */}
      {toolCall.emissions.map((emission) => {
        const Component = emission.component
        return (
          <div key={emission.id} data-testid="tool-emission">
            {Component && (
              <Component
                {...emission.props}
                onRespond={emission.onRespond}
                disabled={emission.status !== 'pending'}
                response={emission.response}
              />
            )}
            {emission.status === 'pending' && (
              <button
                data-testid="emission-submit"
                onClick={() => emission.onRespond?.('submitted')}
              >
                Submit
              </button>
            )}
          </div>
        )
      })}

      {/* Tool result */}
      {toolCall.result !== undefined && (
        <div data-testid="tool-result">
          {typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result)}
        </div>
      )}

      {/* Tool error */}
      {toolCall.state === 'error' && toolCall.error && (
        <div data-testid="tool-error">{toolCall.error}</div>
      )}
    </div>
  )
}

/**
 * Renders a single message.
 */
function MessageBlock({ message }: { message: ChatMessage }) {
  const hasToolCalls = message.parts.some((p) => p.type === 'tool-call')

  return (
    <div
      data-testid="message"
      data-role={message.role}
      data-message-id={message.id}
      data-streaming={message.isStreaming ? 'true' : 'false'}
    >
      <div data-testid="message-content">
        {message.parts.map((part) => {
          if (part.type === 'text') {
            // Use rendered HTML if available, otherwise raw content
            return part.rendered ? (
              <span key={part.id} dangerouslySetInnerHTML={{ __html: part.rendered }} />
            ) : (
              <span key={part.id}>{part.content}</span>
            )
          }

          if (part.type === 'reasoning') {
            return (
              <details key={part.id} data-testid="reasoning">
                <summary>Thinking...</summary>
                {part.rendered ? (
                  <div dangerouslySetInnerHTML={{ __html: part.rendered }} />
                ) : (
                  <div>{part.content}</div>
                )}
              </details>
            )
          }

          return null
        })}
      </div>

      {/* Tool calls */}
      {hasToolCalls && (
        <div data-testid="tool-calls">
          {message.parts.map((part) => {
            if (part.type === 'tool-call') {
              return <ToolCallBlock key={part.id} toolCall={part} />
            }
            return null
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Minimal Chat Demo component for E2E testing.
 */
export function ChatDemo({ sessionId = 'default', baseUrl, ...options }: ChatDemoProps) {
  const chatOptions = baseUrl ? { ...options, baseUrl } : options
  const { messages, isStreaming, send, abort, reset, error } = useChat(chatOptions)

  const [input, setInput] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isStreaming) return
    send(input.trim())
    setInput('')
  }

  return (
    <div
      data-testid="chat-session"
      data-session-id={sessionId}
      data-streaming={isStreaming ? 'true' : 'false'}
    >
      {/* Error display */}
      {error && <div data-testid="error-message">{error}</div>}

      {/* Message list */}
      <div data-testid="message-list">
        {messages.map((msg) => (
          <MessageBlock key={msg.id} message={msg} />
        ))}
      </div>

      {/* Input form */}
      <form data-testid="chat-input-form" onSubmit={handleSubmit}>
        <input
          data-testid="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isStreaming ? 'Waiting...' : 'Type a message...'}
          disabled={isStreaming}
        />

        {isStreaming ? (
          <button data-testid="abort-button" type="button" onClick={abort}>
            Stop
          </button>
        ) : (
          <button data-testid="send-button" type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>

      {/* Reset button */}
      <button
        data-testid="reset-button"
        type="button"
        onClick={reset}
        disabled={isStreaming || messages.length === 0}
      >
        Reset
      </button>
    </div>
  )
}

export default ChatDemo
