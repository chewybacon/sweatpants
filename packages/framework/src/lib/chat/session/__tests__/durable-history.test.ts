import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { replayFramesToConversation, deduplicateMessages } from '../durable-history.ts'
import type { DurableFrame } from '../durable-history.ts'
import type { StreamEvent } from '../streaming.ts'
import type { Message } from '../../types.ts'
import type { ChatPatch } from '../../patches/index.ts'

function makeFrame(event: StreamEvent, lsn: number = 0): DurableFrame {
  return { lsn, event }
}

function makeConversationState(messages: Message[], opts?: {
  assistantContent?: string
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>
  replayTraces?: Array<{ callId: string; toolName: string; trace: unknown }>
}): StreamEvent {
  const cs: any = {
    type: 'conversation_state' as const,
    conversationState: {
      messages,
      assistantContent: opts?.assistantContent ?? '',
      toolCalls: opts?.toolCalls ?? [],
      serverToolResults: [],
    },
  }
  if (opts?.replayTraces) {
    cs.conversationState.replay = {
      toolTraces: opts.replayTraces,
    }
  }
  return cs
}

function makeAgUiCheckpoint(messages: Message[], opts?: {
  threadId?: string
  runId?: string
  assistantContent?: string
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>
  replayTraces?: Array<{ callId: string; toolName: string; trace: unknown }>
}): StreamEvent {
  const checkpoint: any = {
    type: 'ag_ui_checkpoint' as const,
    checkpoint: {
      run: {
        threadId: opts?.threadId ?? 'thread-1',
        runId: opts?.runId ?? 'run-1',
      },
      messages: {
        messages,
      },
      state: {
        assistantContent: opts?.assistantContent ?? '',
        toolCalls: opts?.toolCalls ?? [],
        serverToolResults: [],
      },
    },
  }
  if (opts?.replayTraces) {
    checkpoint.checkpoint.state.replay = {
      toolTraces: opts.replayTraces,
    }
  }
  return checkpoint
}

function makeAgUiStateSnapshot(opts: {
  threadId?: string
  runId?: string
    pendingClientActions?: Array<{
      toolCallId: string
      toolName: string
      kind: 'handoff' | 'elicit'
      params?: unknown
      sessionId?: string
      elicitId?: string
      key?: string
    message?: string
    schema?: Record<string, unknown>
    data?: unknown
    usesHandoff?: boolean
  }>
}): StreamEvent {
  return {
    type: 'ag_ui_state_snapshot',
    run: {
      threadId: opts.threadId ?? 'thread-1',
      runId: opts.runId ?? 'run-1',
    },
    state: {
      ...(opts.pendingClientActions ? { pendingClientActions: opts.pendingClientActions } : {}),
    },
  }
}

function isHistoryPatch(p: ChatPatch): p is ChatPatch & { type: 'history_message' | 'user_message' } {
  return p.type === 'history_message' || p.type === 'user_message'
}

function getHistoryMessages(patches: ChatPatch[]): Message[] {
  return patches.filter(isHistoryPatch).map((p) => (p as any).message as Message)
}

describe('replayFramesToConversation', () => {
  it('seeds messages from first conversation_state and deduplicates subsequent events', async () => {
    const callId1 = 'call_pick_card_1'
    const callId2 = 'call_pick_card_2'

    const frames: DurableFrame[] = [
      makeFrame(makeConversationState(
        [{ id: 'msg-1', role: 'user', content: 'Draw 3 cards and let me pick one' }],
      ), 1),
      makeFrame({ type: 'text', content: 'I will draw cards for you.' }, 2),
      makeFrame({
        type: 'tool_calls',
        calls: [{ id: callId1, name: 'pick_card', arguments: { count: 3 } }],
      }, 3),
      makeFrame({
        type: 'tool_result',
        id: callId1,
        name: 'pick_card',
        content: 'The user selected the 3 of Hearts.',
      }, 4),
      makeFrame({ type: 'complete', text: 'You picked the 3 of Hearts!' }, 5),

      makeFrame(makeConversationState(
        [
          { id: 'msg-1', role: 'user', content: 'Draw 3 cards and let me pick one' },
          { id: 'msg-2', role: 'assistant', content: '', tool_calls: [{ id: callId1, type: 'function' as const, function: { name: 'pick_card', arguments: { count: 3 } } }] },
          { id: 'msg-3', role: 'tool', tool_call_id: callId1, content: 'The user selected the 3 of Hearts.' },
          { id: 'msg-4', role: 'assistant', content: 'You picked the 3 of Hearts!' },
          { id: 'msg-5', role: 'user', content: 'Draw another 3 cards' },
        ],
        {
          assistantContent: '',
          toolCalls: [],
        },
      ), 6),
      makeFrame({ type: 'text', content: 'Drawing more cards...' }, 7),
      makeFrame({
        type: 'tool_calls',
        calls: [{ id: callId2, name: 'pick_card', arguments: { count: 3 } }],
      }, 8),
      makeFrame({
        type: 'tool_result',
        id: callId2,
        name: 'pick_card',
        content: 'The user selected the Q of Diamonds.',
      }, 9),
      makeFrame({ type: 'complete', text: 'You picked the Queen of Diamonds!' }, 10),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)

    const assistantWithToolCalls = messages.filter(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
    )
    const allToolCallIds = assistantWithToolCalls.flatMap((m) => m.tool_calls!.map((tc) => tc.id))
    const uniqueToolCallIds = [...new Set(allToolCallIds)]

    expect(uniqueToolCallIds).toHaveLength(2)
    expect(uniqueToolCallIds).toContain(callId1)
    expect(uniqueToolCallIds).toContain(callId2)

    const userMessages = messages.filter((m) => m.role === 'user')
    expect(userMessages.length).toBeGreaterThanOrEqual(2)
  })

  it('deduplicates tool result events when already seeded from conversation_state', async () => {
    const callId = 'call_pick_card_1'

    const frames: DurableFrame[] = [
      makeFrame(makeConversationState(
        [
          { id: 'msg-1', role: 'user', content: 'Draw a card' },
          { id: 'msg-2', role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'pick_card', arguments: {} } }] },
          { id: 'msg-3', role: 'tool', tool_call_id: callId, content: 'Selected 3 of Hearts' },
          { id: 'msg-4', role: 'assistant', content: 'You picked 3 of Hearts!' },
        ],
      ), 1),

      makeFrame({
        type: 'tool_result',
        id: callId,
        name: 'pick_card',
        content: 'Selected 3 of Hearts',
      }, 2),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)
    const toolMessages = messages.filter(
      (m) => m.role === 'tool' && m.tool_call_id === callId,
    )

    expect(toolMessages).toHaveLength(1)
  })

  it('supplements missing user messages from second conversation_state', async () => {
    const frames: DurableFrame[] = [
      makeFrame(makeConversationState(
        [{ id: 'msg-1', role: 'user', content: 'First message' }],
      ), 1),
      makeFrame({ type: 'text', content: 'Okay!' }, 2),
      makeFrame({ type: 'complete', text: 'Okay!' }, 3),
      makeFrame(makeConversationState(
        [
          { id: 'msg-1', role: 'user', content: 'First message' },
          { id: 'msg-2', role: 'assistant', content: 'Okay!' },
          { id: 'msg-3', role: 'user', content: 'Second message' },
        ],
      ), 4),
      makeFrame({ type: 'text', content: 'Got it!' }, 5),
      makeFrame({ type: 'complete', text: 'Got it!' }, 6),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)
    const userContents = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)

    expect(userContents).toContain('First message')
    expect(userContents).toContain('Second message')
  })

  it('deduplicates complete events using seededAssistantContent from all conversation_state events', async () => {
    const callId = 'call_pick_card'

    const frames: DurableFrame[] = [
      makeFrame(makeConversationState(
        [{ id: 'msg-1', role: 'user', content: 'Draw a card' }],
      ), 1),

      makeFrame({
        type: 'tool_calls',
        calls: [{ id: callId, name: 'pick_card', arguments: {} }],
      }, 2),
      makeFrame({
        type: 'tool_result',
        id: callId,
        name: 'pick_card',
        content: 'Selected 3 of Hearts',
      }, 3),

      makeFrame(makeConversationState(
        [
          { id: 'msg-1', role: 'user', content: 'Draw a card' },
          { id: 'msg-2', role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'pick_card', arguments: {} } }] },
          { id: 'msg-3', role: 'tool', tool_call_id: callId, content: 'Selected 3 of Hearts' },
          { id: 'msg-4', role: 'assistant', content: 'You picked 3 of Hearts!' },
        ],
      ), 4),

      makeFrame({ type: 'complete', text: 'You picked 3 of Hearts!' }, 5),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)
    const completionTexts = messages
      .filter((m) => m.role === 'assistant' && !m.tool_calls?.length && m.content)
      .map((m) => m.content)

    const youPickedCount = completionTexts.filter((t) => t === 'You picked 3 of Hearts!').length
    expect(youPickedCount).toBe(1)
  })

  it('preserves unique tool call IDs across turns in a two-turn conversation', async () => {
    const callId1 = 'call_pick_card_1'
    const callId2 = 'call_pick_card_2'

    const frames: DurableFrame[] = [
      makeFrame(makeConversationState(
        [{ id: 'msg-1', role: 'user', content: 'Draw a card' }],
      ), 1),

      makeFrame({
        type: 'tool_calls',
        calls: [{ id: callId1, name: 'pick_card', arguments: { count: 3 } }],
      }, 2),
      makeFrame({
        type: 'tool_result',
        id: callId1,
        name: 'pick_card',
        content: 'Selected 3 of Hearts',
      }, 3),
      makeFrame({ type: 'complete', text: 'You picked 3 of Hearts!' }, 4),

      makeFrame(makeConversationState(
        [
          { id: 'msg-1', role: 'user', content: 'Draw a card' },
          { id: 'msg-2', role: 'assistant', content: '', tool_calls: [{ id: callId1, type: 'function' as const, function: { name: 'pick_card', arguments: { count: 3 } } }] },
          { id: 'msg-3', role: 'tool', tool_call_id: callId1, content: 'Selected 3 of Hearts' },
          { id: 'msg-4', role: 'assistant', content: 'You picked 3 of Hearts!' },
          { id: 'msg-5', role: 'user', content: 'Draw another card' },
        ],
      ), 5),

      makeFrame({
        type: 'tool_calls',
        calls: [{ id: callId2, name: 'pick_card', arguments: { count: 3 } }],
      }, 6),
      makeFrame({
        type: 'tool_result',
        id: callId2,
        name: 'pick_card',
        content: 'Selected Q of Diamonds',
      }, 7),
      makeFrame({ type: 'complete', text: 'You picked Q of Diamonds!' }, 8),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)
    const toolMessages = messages.filter((m) => m.role === 'tool')
    const toolCallIds = toolMessages.map((m) => m.tool_call_id)
    const uniqueToolCallIds = [...new Set(toolCallIds)]

    expect(toolCallIds).toContain(callId1)
    expect(toolCallIds).toContain(callId2)
    expect(uniqueToolCallIds).toHaveLength(2)
  })

  it('deduplicates complete events against local history when they come before second conversation_state', async () => {
    const callId1 = 'call_pick_card_1'

    const frames: DurableFrame[] = [
      makeFrame(makeConversationState(
        [{ id: 'msg-1', role: 'user', content: 'Draw a card' }],
      ), 1),

      makeFrame({
        type: 'tool_calls',
        calls: [{ id: callId1, name: 'pick_card', arguments: {} }],
      }, 2),
      makeFrame({
        type: 'tool_result',
        id: callId1,
        name: 'pick_card',
        content: 'Picked 3H',
      }, 3),
      makeFrame({ type: 'complete', text: '' }, 4),

      makeFrame(makeConversationState(
        [
          { id: 'msg-1', role: 'user', content: 'Draw a card' },
          { id: 'msg-2', role: 'assistant', content: '', tool_calls: [{ id: callId1, type: 'function' as const, function: { name: 'pick_card', arguments: {} } }] },
          { id: 'msg-3', role: 'tool', tool_call_id: callId1, content: 'Picked 3H' },
          { id: 'msg-4', role: 'assistant', content: 'You picked 3H!' },
        ],
      ), 5),

      makeFrame({ type: 'complete', text: 'You picked 3H!' }, 6),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)
    const completionTexts = messages.filter(
      (m) => m.role === 'assistant' && !m.tool_calls?.length && m.content,
    ).map((m) => m.content)

    const youPickedCount = completionTexts.filter((t) => t === 'You picked 3H!').length
    expect(youPickedCount).toBe(1)
  })

  it('does not invent message ids during replay for conversation_state messages', async () => {
    const frames: DurableFrame[] = [
      makeFrame(makeConversationState([
        { id: 'user:call_1', role: 'user', content: 'Draw a card' },
        {
          id: 'assistant:tools:call_1',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'pick_card', arguments: {} } }],
        },
        { id: 'tool:call_1', role: 'tool', tool_call_id: 'call_1', content: 'Selected Ace of Spades' },
        { id: 'assistant:final:call_1', role: 'assistant', content: 'You picked the Ace of Spades.' },
      ]), 1),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)
    expect(messages.map((message) => message.id)).toEqual([
      'user:call_1',
      'assistant:tools:call_1',
      'tool:call_1',
      'assistant:final:call_1',
    ])
  })

  it('seeds history from ag_ui_checkpoint messages', async () => {
    const frames: DurableFrame[] = [
      makeFrame(makeAgUiCheckpoint([
        { id: 'user:u1', role: 'user', content: 'Draw a card' },
        {
          id: 'assistant:tools:call_1',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'pick_card', arguments: {} } }],
        },
        { id: 'tool:call_1', role: 'tool', tool_call_id: 'call_1', content: 'Selected Ace of Spades' },
        { id: 'assistant:final:call_1', role: 'assistant', content: 'You picked the Ace of Spades.' },
      ]), 1),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)
    expect(messages.map((message) => message.id)).toEqual([
      'user:u1',
      'assistant:tools:call_1',
      'tool:call_1',
      'assistant:final:call_1',
    ])
  })

  it('reconstructs pending client actions from ag_ui_state_snapshot', async () => {
    const frames: DurableFrame[] = [
      makeFrame(
        makeAgUiStateSnapshot({
          pendingClientActions: [
            {
              toolCallId: 'call_1',
              toolName: 'pick_card',
              kind: 'handoff',
              params: { count: 2 },
              data: { cards: ['A', 'K'] },
              usesHandoff: true,
            },
            {
              toolCallId: 'call_2',
              toolName: 'confirm',
              kind: 'elicit',
              sessionId: 'session-2',
              elicitId: 'elicit-2',
              key: 'confirmAction',
              message: 'Confirm?',
              schema: { type: 'object' },
            },
          ],
        }),
        1,
      ),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    expect(result.patches).toContainEqual({
      type: 'pending_handoff',
      handoff: {
        callId: 'call_1',
        toolName: 'pick_card',
        params: { count: 2 },
        data: { cards: ['A', 'K'] },
        usesHandoff: true,
      },
    })
    expect(result.patches.some((patch) => patch.type === 'elicit_start')).toBe(true)
    expect(result.patches.some((patch) => patch.type === 'elicit')).toBe(true)
  })

  it('requires ids on conversation_state messages for new transcripts', async () => {
    const frames: DurableFrame[] = [
      makeFrame(makeConversationState([
        { role: 'user', content: 'Draw a card' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'pick_card', arguments: {} } }],
        },
      ] as Message[]), 1),
    ]

    await expect(run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })).rejects.toThrow(/message id/i)
  })

  it('updates seededToolCallIds from second conversation_state to prevent duplicate complete events', async () => {
    const callId1 = 'call_pick_card_1'
    const callId2 = 'call_pick_card_2'

    const frames: DurableFrame[] = [
      makeFrame(makeConversationState(
        [{ id: 'msg-1', role: 'user', content: 'Draw a card' }],
      ), 1),

      makeFrame({
        type: 'tool_calls',
        calls: [{ id: callId1, name: 'pick_card', arguments: {} }],
      }, 2),
      makeFrame({
        type: 'tool_result',
        id: callId1,
        name: 'pick_card',
        content: 'Picked 3H',
      }, 3),
      makeFrame({ type: 'complete', text: '' }, 4),

      makeFrame(makeConversationState(
        [
          { id: 'msg-1', role: 'user', content: 'Draw a card' },
          { id: 'msg-2', role: 'assistant', content: '', tool_calls: [{ id: callId1, type: 'function' as const, function: { name: 'pick_card', arguments: {} } }] },
          { id: 'msg-3', role: 'tool', tool_call_id: callId1, content: 'Picked 3H' },
          { id: 'msg-4', role: 'assistant', content: 'You picked 3H' },
          { id: 'msg-5', role: 'user', content: 'Another' },
        ],
        { assistantContent: '', toolCalls: [{ id: callId2, name: 'pick_card', arguments: {} }] },
      ), 5),

      makeFrame({
        type: 'tool_calls',
        calls: [{ id: callId2, name: 'pick_card', arguments: {} }],
      }, 6),
      makeFrame({
        type: 'tool_result',
        id: callId2,
        name: 'pick_card',
        content: 'Picked QD',
      }, 7),
      makeFrame({ type: 'complete', text: '' }, 8),
    ]

    const result = await run(function* () {
      return yield* replayFramesToConversation(frames, [], [])
    })

    const messages = getHistoryMessages(result.patches)

    const assistantToolCalls = messages.filter(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
    )

    const call1Messages = assistantToolCalls.filter(
      (m) => m.tool_calls!.some((tc) => tc.id === callId1),
    )
    expect(call1Messages).toHaveLength(1)

    const call2Messages = assistantToolCalls.filter(
      (m) => m.tool_calls!.some((tc) => tc.id === callId2),
    )
    expect(call2Messages).toHaveLength(1)
  })
})

describe('deduplicateMessages', () => {
  it('keeps the tool message with replay metadata when duplicates exist', () => {
    const callId = 'call_1'
    const messages: Message[] = [
      { id: '1', role: 'tool' as const, tool_call_id: callId, content: 'Result without replay' },
      { id: '2', role: 'tool' as const, tool_call_id: callId, content: 'Result with replay', replay: { toolName: 'pick_card', trace: {} as any } },
    ]

    const result = deduplicateMessages(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe('Result with replay')
    expect(result[0]!.replay).toBeDefined()
  })

  it('deduplicates assistant messages by tool call IDs', () => {
    const messages: Message[] = [
      { id: '1', role: 'assistant' as const, content: '', tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'pick_card', arguments: {} } }] },
      { id: '2', role: 'assistant' as const, content: '', tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'pick_card', arguments: {} } }] },
    ]

    const result = deduplicateMessages(messages)
    expect(result).toHaveLength(1)
  })

  it('preserves distinct assistant messages with different tool calls', () => {
    const messages: Message[] = [
      { id: '1', role: 'assistant' as const, content: '', tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'pick_card', arguments: {} } }] },
      { id: '2', role: 'assistant' as const, content: '', tool_calls: [{ id: 'call_2', type: 'function' as const, function: { name: 'pick_card', arguments: {} } }] },
    ]

    const result = deduplicateMessages(messages)
    expect(result).toHaveLength(2)
  })
})
