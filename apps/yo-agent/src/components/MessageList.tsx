/**
 * Message List Component
 *
 * Displays the chat message history with newest messages at the bottom.
 * Implements virtual scrolling to show only messages that fit in the viewport.
 *
 * Uses FrameRenderer for assistant messages to display rendered markdown/code.
 */
import React, { useMemo } from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { FrameRenderer, type Frame } from '../pipeline/index.ts'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
  /** Rendered frame for assistant messages */
  frame?: Frame
}

interface MessageListProps {
  messages: Message[]
  isStreaming?: boolean
  /** Available height in lines (from parent) */
  height?: number
  /** Current frame for the streaming assistant message */
  currentFrame?: Frame | null
}

/**
 * Estimate how many lines a message will take.
 * This is approximate - wrapping depends on terminal width.
 */
function estimateMessageHeight(message: Message, width: number): number {
  const contentWidth = Math.max(width - 6, 20) // Account for padding/prefix/borders
  
  // If message has a frame, estimate based on blocks
  if (message.frame && message.frame.blocks.length > 0) {
    let totalLines = 0
    
    // Add 1 for "Assistant:" header
    if (message.role === 'assistant') {
      totalLines += 1
    }
    
    for (const block of message.frame.blocks) {
      const content = block.rendered || block.raw
      const lines = content.split('\n')
      
      for (const line of lines) {
        // Strip ANSI codes for length calculation
        const plainLine = line.replace(/\x1b\[[0-9;]*m/g, '')
        totalLines += Math.max(1, Math.ceil(plainLine.length / contentWidth))
      }
      
      if (block.type === 'code') {
        // Code blocks have: language label (1) + top border (1) + bottom border (1) + margins (2)
        totalLines += 5
      }
      
      // Block margin
      totalLines += 1
    }
    
    return totalLines
  }
  
  // Fallback: estimate from raw content
  const lines = message.content.split('\n')
  let totalLines = 0
  
  for (const line of lines) {
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

export function MessageList({ messages, isStreaming = false, height = 20, currentFrame }: MessageListProps) {
  // Calculate which messages to show based on available height
  const visibleMessages = useMemo(() => {
    if (messages.length === 0) return []
    
    // Reserve space for streaming indicator and some buffer
    const availableHeight = Math.max(height - 4, 5)
    
    // Work backwards from newest messages
    const result: Message[] = []
    let usedHeight = 0
    const terminalWidth = 80
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      const msgHeight = estimateMessageHeight(msg, terminalWidth)
      
      // Always include at least the most recent message
      if (result.length === 0 || usedHeight + msgHeight <= availableHeight) {
        result.unshift(msg)
        usedHeight += msgHeight
      } else {
        break
      }
    }
    
    return result
  }, [messages, height])

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
      {visibleMessages.map((message, index) => (
        <MessageBubble 
          key={message.id} 
          message={message}
          // Pass frame to the last assistant message if it's streaming
          frame={
            isStreaming && 
            message.role === 'assistant' && 
            index === visibleMessages.length - 1 
              ? currentFrame 
              : undefined
          }
        />
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
  /** Frame for rendered content (for streaming assistant messages) */
  frame?: Frame | null
}

function MessageBubble({ message, frame }: MessageBubbleProps) {
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
      // Use frame from props (streaming) or message (completed)
      const activeFrame = frame || message.frame
      
      // If we have a frame, use FrameRenderer for rich output
      if (activeFrame && activeFrame.blocks.length > 0) {
        return (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="cyan" bold>Assistant:</Text>
            <Box marginLeft={2}>
              <FrameRenderer frame={activeFrame} />
            </Box>
          </Box>
        )
      }
      // Fallback to plain text
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
