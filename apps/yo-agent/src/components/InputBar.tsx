/**
 * Input Bar Component
 *
 * Fixed at the bottom, handles user input.
 */
import React, { useState, useCallback } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'
import type { AgentMode } from './App.tsx'

interface InputBarProps {
  mode: AgentMode
  onSubmit: (value: string) => void
  disabled?: boolean
}

export function InputBar({ mode, onSubmit, disabled = false }: InputBarProps) {
  const [value, setValue] = useState('')

  const handleSubmit = useCallback((input: string) => {
    if (input.trim() && !disabled) {
      onSubmit(input.trim())
      setValue('')
    }
  }, [onSubmit, disabled])

  const borderColor = mode === 'plan' ? 'cyan' : 'magenta'
  const placeholder = mode === 'plan' 
    ? 'Ask about the codebase...' 
    : 'Talk to HAL...'

  return (
    <Box 
      borderStyle="round" 
      borderColor={borderColor}
      paddingX={1}
    >
      {disabled ? (
        <Text color="cyan">
          <Spinner type="dots" />
          {' '}
        </Text>
      ) : (
        <Text color="gray">&gt; </Text>
      )}
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={disabled ? 'Thinking...' : placeholder}
      />
    </Box>
  )
}
