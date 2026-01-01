/**
 * Main App Component
 *
 * Holy Grail Layout:
 * ┌─────────────────────────────────────────────────┐
 * │ StatusBar (fixed height)                        │
 * ├────────────────────────────────┬────────────────┤
 * │                                │                │
 * │  Main Chat (80%)               │  Sidebar (20%) │
 * │  (grows to fill)               │  (context)     │
 * │                                │                │
 * ├────────────────────────────────┴────────────────┤
 * │ Input (fixed height)                            │
 * └─────────────────────────────────────────────────┘
 */
import React, { useState } from 'react'
import { Box, useApp, useInput, useStdout } from 'ink'
import { StatusBar } from './StatusBar.tsx'
import { MessageList } from './MessageList.tsx'
import { Sidebar } from './Sidebar.tsx'
import { InputBar } from './InputBar.tsx'
import { useAgentChat } from '../hooks/useAgentChat.ts'
import { useAgent } from '../lib/agent-context.tsx'

export type AgentMode = 'plan' | 'build'

export function App() {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const agent = useAgent()
  const [mode, setMode] = useState<AgentMode>('plan')
  const { messages, isStreaming, send, error } = useAgentChat({ mode })

  // Get terminal dimensions
  const width = stdout?.columns ?? 80
  const height = stdout?.rows ?? 24

  // Calculate available height for message list
  // Total height - status bar (1) - input bar (3) - borders (4) - padding (2)
  const messageListHeight = Math.max(height - 10, 5)

  // Global key handler
  useInput((input, key) => {
    if (key.escape) {
      setMode(prev => prev === 'plan' ? 'build' : 'plan')
    }
  })

  const toggleMode = () => {
    setMode(prev => prev === 'plan' ? 'build' : 'plan')
  }

  return (
    <Box 
      flexDirection="column" 
      width={width} 
      height={height}
    >
      {/* Header - fixed height */}
      <Box flexShrink={0}>
        <StatusBar 
          mode={mode} 
          onToggleMode={toggleMode}
          isReady={agent.isReady}
          lastHmrEvent={agent.lastHmrEvent}
        />
      </Box>

      {/* Main content area - grows to fill */}
      <Box flexGrow={1} flexDirection="row">
        {/* Chat area - 80% */}
        <Box 
          flexDirection="column" 
          width="80%"
          borderStyle="single"
          borderColor="gray"
        >
          <MessageList messages={messages} isStreaming={isStreaming} height={messageListHeight} />
        </Box>

        {/* Sidebar - 20% */}
        <Box 
          width="20%" 
          borderStyle="single"
          borderColor="gray"
        >
          <Sidebar mode={mode} error={error} />
        </Box>
      </Box>

      {/* Input - fixed height */}
      <Box flexShrink={0}>
        <InputBar 
          mode={mode} 
          onSubmit={send}
          disabled={isStreaming}
        />
      </Box>
    </Box>
  )
}
