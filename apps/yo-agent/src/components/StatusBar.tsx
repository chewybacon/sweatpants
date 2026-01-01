/**
 * Status Bar Component
 *
 * Shows the current mode, HMR status, and key bindings.
 */
import React from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import type { AgentMode } from './App.tsx'

interface StatusBarProps {
  mode: AgentMode
  onToggleMode: () => void
  isReady?: boolean
  lastHmrEvent?: { type: string; file: string; timestamp: number } | null
}

export function StatusBar({ mode, isReady = false, lastHmrEvent }: StatusBarProps) {
  const modeColor = mode === 'plan' ? 'cyan' : 'magenta'
  const modeLabel = mode.toUpperCase()

  // Extract just the filename from the path
  const hmrFile = lastHmrEvent?.file.split('/').pop()

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={1}>
        <Text bold>yo-agent</Text>
        <Text color="gray">|</Text>
        <Text color={modeColor} bold>
          [{modeLabel}]
        </Text>
        {!isReady && (
          <>
            <Text color="gray">|</Text>
            <Text color="yellow">
              <Spinner type="dots" />
              {' '}Starting...
            </Text>
          </>
        )}
        {lastHmrEvent && (
          <>
            <Text color="gray">|</Text>
            <Text color="green">
              HMR: {hmrFile}
            </Text>
          </>
        )}
      </Box>
      <Box>
        <Text color="gray">
          ESC: mode | ^C: exit
        </Text>
      </Box>
    </Box>
  )
}
