/**
 * Message List Component
 *
 * Displays the chat message history with newest messages at the bottom.
 * Implements virtual scrolling to show only messages that fit in the viewport.
 */
import React, { useMemo } from 'react'
import { Box, Text, measureElement, DOMElement } from 'ink'
import Spinner from 'ink-spinner'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
}

interface MessageListProps {
  messages: Message[]
  isStreaming?: boolean
  /** Available height in lines (from parent) */
  height?: number
}

/**
 * Estimate how many lines a message will take.
 * This is approximate - wrapping depends on terminal width.
 */
function estimateMessageHeight(message: Message, width: number): number {
  const contentWidth = Math.max(width - 4, 20) // Account for padding/prefix
  const lines = message.content.split('\n')
  let totalLines = 0
  
  for (const line of lines) {
    // Each line wraps based on width
    totalLines += Math.max(1, Math.ceil(line.length / contentWidth))
  }
  
  // Add 1 for role prefix line (assistant has separate line)
  if (message.role === 'assistant') {
    totalLines += 1
  }
  
  // Add 1 for marginBottom
  totalLines += 1
  
  return totalLines
}

export function MessageList({ messages, isStreaming = false, height = 20 }: MessageListProps) {
  // Calculate which messages to show based on available height
  const visibleMessages = useMemo(() => {
    if (messages.length === 0) return []
    
    // Reserve space for streaming indicator
    const availableHeight = isStreaming ? height - 2 : height - 1
    
    // Work backwards from newest messages
    const result: Message[] = []
    let usedHeight = 0
    const terminalWidth = 80 // Approximate, could get from useStdout
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      const msgHeight = estimateMessageHeight(msg, terminalWidth)
      
      if (usedHeight + msgHeight > availableHeight) {
        break
      }
      
      result.unshift(msg)
      usedHeight += msgHeight
    }
    
    return result
  }, [messages, isStreaming, height])

  const hiddenCount = messages.length - visibleMessages.length

  if (messages.length === 0 && !isStreaming) {
    return (
      <Box 
        flexDirection="column" 
        justifyContent="flex-end" 
        flexGrow={1}
        padding={1}
      >
        <Text color="gray" dimColor>
          Welcome to yo-agent!
        </Text>
        <Text color="gray" dimColor>
          Press ESC to toggle plan/build modes.
        </Text>
      </Box>
    )
  }

  return (
    <Box 
      flexDirection="column" 
      justifyContent="flex-end" 
      flexGrow={1}
      padding={1}
    >
      {hiddenCount > 0 && (
        <Box marginBottom={1}>
          <Text color="gray" dimColor>
            ↑ {hiddenCount} earlier message{hiddenCount > 1 ? 's' : ''}
          </Text>
        </Box>
      )}
      {visibleMessages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      {isStreaming && (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
            {' '}Thinking...
          </Text>
        </Box>
      )}
    </Box>
  )
}

interface MessageBubbleProps {
  message: Message
}

function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, toolName } = message

  switch (role) {
    case 'user':
      return (
        <Box marginBottom={1}>
          <Text color="green" bold>You: </Text>
          <Text wrap="wrap">{content}</Text>
        </Box>
      )

    case 'assistant':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan" bold>Assistant:</Text>
          <Box marginLeft={2}>
            <Text wrap="wrap">{content}</Text>
          </Box>
        </Box>
      )

    case 'tool':
      return (
        <Box marginBottom={1}>
          <Text color="yellow" dimColor>
            [Tool: {toolName}] {content.slice(0, 80)}
            {content.length > 80 ? '...' : ''}
          </Text>
        </Box>
      )

    case 'system':
      return (
        <Box marginBottom={1}>
          <Text color="gray" dimColor>
            System: {content}
          </Text>
        </Box>
      )

    default:
      return null
  }
}
