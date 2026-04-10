import { describe, expect, it } from 'vitest'
import { run, createChannel, spawn, each, resource, type Operation, type Stream } from 'effection'
import { mapStreamEventsToPatches } from '../event-mapper.ts'
import type { StreamEvent } from '../streaming.ts'
import type { ChatPatch } from '../../patches/index.ts'

async function mapEvents(events: StreamEvent[]): Promise<{
  patches: ChatPatch[]
  result: Awaited<ReturnType<typeof runMapEvents>>['result']
}> {
  const result = await runMapEvents(events)
  return result
}

function runMapEvents(events: StreamEvent[]) {
  return run(function* () {
    const patches = createChannel<ChatPatch, void>()
    const collectedPatches: ChatPatch[] = []
    const eventStream: Stream<unknown, void> = resource(function* (provide) {
      let index = 0

      yield* provide({
        *next(): Operation<IteratorResult<unknown, void>> {
          if (index >= events.length) {
            return { done: true, value: undefined }
          }

          const event = events[index]!
          index += 1
          return {
            done: false,
            value: {
              lsn: index,
              event,
            },
          }
        },
      })
    })

    yield* spawn(function* () {
      for (const patch of yield* each(patches)) {
        collectedPatches.push(patch)
        yield* each.next()
      }
    })

    const resultTask = yield* spawn(function* () {
      return yield* mapStreamEventsToPatches(eventStream, patches)
    })
    const result = yield* resultTask
    yield* patches.close()

    return {
      patches: collectedPatches,
      result,
    }
  })
}

describe('mapStreamEventsToPatches', () => {
  it('maps AG-UI assistant text lifecycle into streaming text patches', async () => {
    const { patches, result } = await mapEvents([
      {
        type: 'ag_ui_text_message_start',
        messageId: 'assistant:final:run-1',
        role: 'assistant',
      },
      {
        type: 'ag_ui_text_message_content',
        messageId: 'assistant:final:run-1',
        delta: 'Hello',
      },
      {
        type: 'ag_ui_text_message_content',
        messageId: 'assistant:final:run-1',
        delta: ' world',
      },
      {
        type: 'ag_ui_text_message_end',
        messageId: 'assistant:final:run-1',
      },
      {
        type: 'ag_ui_run_finished',
        run: { threadId: 'thread-1', runId: 'run-1' },
      },
    ])

    expect(patches.filter((patch) => patch.type === 'streaming_text')).toEqual([
      { type: 'streaming_text', content: 'Hello' },
      { type: 'streaming_text', content: ' world' },
    ])
    expect(result).toMatchObject({ type: 'complete', text: 'Hello world' })
  })

  it('maps AG-UI tool lifecycle into one tool_call_start patch', async () => {
    const { patches, result } = await mapEvents([
      {
        type: 'ag_ui_tool_call_start',
        toolCallId: 'call-1',
        toolCallName: 'echo',
      },
      {
        type: 'ag_ui_tool_call_args',
        toolCallId: 'call-1',
        delta: '{"input":',
      },
      {
        type: 'ag_ui_tool_call_args',
        toolCallId: 'call-1',
        delta: '"hello"}',
      },
      {
        type: 'ag_ui_tool_call_end',
        toolCallId: 'call-1',
      },
      {
        type: 'ag_ui_tool_call_result',
        toolCallId: 'call-1',
        toolCallName: 'echo',
        content: 'Mock result for: hello',
      },
      {
        type: 'ag_ui_run_finished',
        run: { threadId: 'thread-1', runId: 'run-1' },
      },
    ])

    expect(patches.filter((patch) => patch.type === 'tool_call_start')).toEqual([
      {
        type: 'tool_call_start',
        call: {
          id: 'call-1',
          name: 'echo',
          arguments: '{"input":"hello"}',
        },
      },
    ])
    expect(result).toMatchObject({
      type: 'complete',
      toolCalls: [{ id: 'call-1', name: 'echo', arguments: { input: 'hello' } }],
      toolResults: [{ id: 'call-1', name: 'echo', content: 'Mock result for: hello' }],
    })
  })

  it('reconstructs handoff and elicit patches from AG-UI state snapshots', async () => {
    const { patches, result } = await mapEvents([
      {
        type: 'ag_ui_state_snapshot',
        run: {
          threadId: 'thread-1',
          runId: 'run-1',
        },
        state: {
          pendingClientActions: [
            {
              toolCallId: 'call-handoff',
              toolName: 'pick_card',
              kind: 'handoff',
              params: { count: 3 },
              data: { cards: ['A', 'K', 'Q'] },
              usesHandoff: true,
            },
          ],
        },
      },
      {
        type: 'ag_ui_checkpoint',
        checkpoint: {
          run: { threadId: 'thread-1', runId: 'run-1' },
          messages: { messages: [] },
          state: {
            assistantContent: '',
            toolCalls: [],
            serverToolResults: [],
          },
        },
      },
    ])

    expect(patches).toContainEqual({
      type: 'isomorphic_tool_state',
      id: 'call-handoff',
      state: 'awaiting_client_approval',
      serverOutput: { cards: ['A', 'K', 'Q'] },
    })
    expect(result).toMatchObject({
      type: 'isomorphic_handoff',
      handoffs: [
        {
          callId: 'call-handoff',
          toolName: 'pick_card',
          params: { count: 3 },
          serverOutput: { cards: ['A', 'K', 'Q'] },
          usesHandoff: true,
        },
      ],
    })
  })

  it('reconstructs elicit result state from AG-UI state snapshots', async () => {
    const { patches, result } = await mapEvents([
      {
        type: 'ag_ui_state_snapshot',
        run: {
          threadId: 'thread-1',
          runId: 'run-1',
        },
        state: {
          pendingClientActions: [
            {
              toolCallId: 'call-elicit',
              toolName: 'confirm',
              kind: 'elicit',
              sessionId: 'session-1',
              elicitId: 'elicit-1',
              key: 'confirmAction',
              message: 'Confirm?',
              schema: { type: 'object' },
            },
          ],
        },
      },
      {
        type: 'ag_ui_checkpoint',
        checkpoint: {
          run: { threadId: 'thread-1', runId: 'run-1' },
          messages: { messages: [] },
          state: {
            assistantContent: '',
            toolCalls: [],
            serverToolResults: [],
          },
        },
      },
    ])

    expect(patches).toContainEqual({
      type: 'elicit_start',
      callId: 'call-elicit',
      toolName: 'confirm',
    })
    expect(patches).toContainEqual({
      type: 'elicit',
      callId: 'call-elicit',
      elicit: {
        elicitId: 'elicit-1',
        sessionId: 'session-1',
        key: 'confirmAction',
        message: 'Confirm?',
        schema: { type: 'object' },
        context: undefined,
        status: 'pending',
        timestamp: expect.any(Number),
      },
    })
    expect(result).toMatchObject({
      type: 'elicit',
      pendingElicitations: [
        {
          callId: 'call-elicit',
          toolName: 'confirm',
          sessionId: 'session-1',
          elicitId: 'elicit-1',
          key: 'confirmAction',
          message: 'Confirm?',
          schema: { type: 'object' },
        },
      ],
    })
  })
})
