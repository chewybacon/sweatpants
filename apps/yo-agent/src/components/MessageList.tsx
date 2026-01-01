/**
 * Message List Component
 *
 * Displays the chat message history with newest messages at the bottom.
 * Uses Scrollable component for auto-scroll-to-bottom behavior.
 *
 * Uses FrameRenderer for assistant messages to display rendered markdown/code.
 */
import React from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { FrameRenderer, type Frame } from '../pipeline/index.ts'
import { Scrollable } from './Scrollable.tsx'

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

export function MessageList({ messages, isStreaming = false, height = 20, currentFrame }: MessageListProps) {
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
    <Box flexDirection="column" flexGrow={1} padding={1}>
      <Scrollable
        height={height - 2} // Account for padding
        scrollToBottom={true}
        flexGrow={1}
        scrollbarThumbColor="cyan"
      >
        {messages.map((message, index) => (
          <MessageBubble 
            key={message.id} 
            message={message}
            // Pass frame to the last assistant message if it's streaming
            frame={
              isStreaming && 
              message.role === 'assistant' && 
              index === messages.length - 1 
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
      </Scrollable>
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
