/**
 * Sidebar Component
 *
 * Shows context information, tool status, and errors.
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { AgentMode } from './App.tsx'

interface SidebarProps {
  mode: AgentMode
  error: string | null
}

export function Sidebar({ mode, error }: SidebarProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="gray">Context</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray" dimColor>Mode: </Text>
        <Text color={mode === 'plan' ? 'cyan' : 'magenta'}>
          {mode.toUpperCase()}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray" dimColor>Tools:</Text>
        {mode === 'plan' ? (
          <Box flexDirection="column" marginLeft={1}>
            <Text color="gray">• read_file</Text>
            <Text color="gray">• glob</Text>
            <Text color="gray">• grep</Text>
            <Text color="gray">• git_status</Text>
          </Box>
        ) : (
          <Box marginLeft={1}>
            <Text color="gray" dimColor>(HAL 9000 mode)</Text>
          </Box>
        )}
      </Box>

      {error && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>Error:</Text>
          <Text color="red" wrap="wrap">{error}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column" flexGrow={1} justifyContent="flex-end">
        <Text color="gray" dimColor>─────────</Text>
        <Text color="gray" dimColor>ESC: mode</Text>
        <Text color="gray" dimColor>^C: exit</Text>
      </Box>
    </Box>
  )
}
