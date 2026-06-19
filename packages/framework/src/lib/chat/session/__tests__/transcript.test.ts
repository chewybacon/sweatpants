import { describe, expect, it } from 'vitest'

import type { Message, ToolCall } from '../../types.ts'
import {
  appendAssistantFinalMessage,
  appendAssistantToolCallMessage,
  appendToolMessage,
  appendUserMessage,
  createTranscriptState,
} from '../transcript.ts'

function toolCall(id: string, name = 'pick_card'): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: {},
    },
  }
}

describe('transcript writer', () => {
  it('appends a deterministic user -> assistant tools -> tool -> final assistant turn', () => {
    const history: Message[] = []
    const state = createTranscriptState(history)

    appendUserMessage(history, state, 'Draw 3 cards')
    appendAssistantToolCallMessage(history, state, [toolCall('call_1')], '')
    appendToolMessage(history, state, 'call_1', 'The user selected the 5 of Hearts.')
    appendAssistantFinalMessage(history, state, 'You picked the 5 of Hearts.')

    expect(history.map((message) => message.id)).toEqual([
      'user:u1',
      'assistant:tools:call_1',
      'tool:call_1',
      'assistant:final:call_1',
    ])
  })

  it('replaces an existing final assistant message with the same deterministic id', () => {
    const history: Message[] = []
    const state = createTranscriptState(history)

    appendUserMessage(history, state, 'Draw 3 cards')
    appendAssistantToolCallMessage(history, state, [toolCall('call_1')], '')
    appendAssistantFinalMessage(history, state, '')
    appendAssistantFinalMessage(history, state, 'You picked the 5 of Hearts.')

    expect(history.filter((message) => message.id === 'assistant:final:call_1')).toHaveLength(1)
    expect(history.at(-1)).toMatchObject({
      id: 'assistant:final:call_1',
      role: 'assistant',
      content: 'You picked the 5 of Hearts.',
    })
  })

  it('can reconstruct a deterministic transcript from append helpers only', () => {
    const normalized: Message[] = []
    const state = createTranscriptState(normalized)

    appendUserMessage(normalized, state, 'Draw 3 cards')
    appendAssistantToolCallMessage(normalized, state, [toolCall('call_1')], '')
    appendToolMessage(normalized, state, 'call_1', 'The user selected the 5 of Hearts.')
    appendAssistantFinalMessage(normalized, state, 'You picked the 5 of Hearts.')

    expect(normalized.map((message) => message.id)).toEqual([
      'user:u1',
      'assistant:tools:call_1',
      'tool:call_1',
      'assistant:final:call_1',
    ])
  })
})
