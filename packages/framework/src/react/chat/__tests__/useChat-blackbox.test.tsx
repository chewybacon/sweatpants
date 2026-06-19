import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { Readable } from 'node:stream'
import { type ReactNode } from 'react'

import { ChatProvider } from '../ChatProvider.tsx'
import { useChat } from '../useChat.ts'
import { useChatSession } from '../useChatSession.ts'

function ndjsonResponse(events: unknown[]): Response {
  const lines = events.map((event, i) => JSON.stringify({ lsn: i + 1, event }) + '\n')
  const nodeStream = Readable.from(lines.map((line) => Buffer.from(line)))
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'X-Session-Id': 'test-session',
    },
  })
}

/** Minimal AG-UI run identifiers shared across events in a single response. */
const run = { threadId: 'test-thread', runId: 'test-run' }

/** Wrap a simple text response in full AG-UI event sequence. */
function agUiTextEvents(text: string, messageId = 'assistant:final:test-run') {
  return [
    { type: 'ag_ui_run_started', run, input: { messages: [] } },
    { type: 'ag_ui_text_message_start', messageId, role: 'assistant' },
    { type: 'ag_ui_text_message_content', messageId, delta: text },
    { type: 'ag_ui_text_message_end', messageId },
    { type: 'ag_ui_run_finished', run },
  ]
}

describe('useChat (black-box)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('hydrates historical tool call messages from durable history', async () => {
    const historyResponse = ndjsonResponse([
      {
        type: 'ag_ui_checkpoint',
        checkpoint: {
          run,
          messages: {
            messages: [
              {
                id: 'user-1',
                role: 'user',
                content: 'Draw me a card',
              },
              {
                id: 'assistant-1',
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'pick_card',
                      arguments: { count: 3 },
                    },
                  },
                ],
              },
              {
                id: 'tool-1',
                role: 'tool',
                tool_call_id: 'call-1',
                content: 'The user selected the Ace of Spades.',
              },
              {
                id: 'assistant-2',
                role: 'assistant',
                content: 'You picked **Ace of Spades**.',
              },
            ],
          },
          state: {
            assistantContent: '',
            toolCalls: [],
            serverToolResults: [],
          },
        },
      },
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: ['pick_card'] },
        persona: null,
      },
    ])

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('conversationId=thread-chat') && (!init?.method || init.method === 'GET')) {
        return historyResponse.clone()
      }

      return ndjsonResponse([
        {
          type: 'session_info',
          capabilities: { thinking: false, streaming: true, tools: [] },
          persona: null,
        },
        ...agUiTextEvents('noop'),
      ])
    }

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatProvider baseUrl="http://localhost/chat">{children}</ChatProvider>
    )

    const { result } = renderHook(
      () => useChat({ conversationId: 'thread-chat', transforms: [] }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.messages.length).toBe(3)
    })

    const assistantWithTool = result.current.messages.find((message) => message.id === 'assistant-1')
    expect(assistantWithTool).toBeTruthy()
    expect(assistantWithTool?.parts.some((part) => part.type === 'tool-call')).toBe(true)
  })

  it('hydrates messages after remount with the same conversationId', async () => {
    const historyResponse = ndjsonResponse([
      {
        type: 'ag_ui_checkpoint',
        checkpoint: {
          run,
          messages: {
            messages: [
              {
                id: 'user-1',
                role: 'user',
                content: 'hello threaded world',
              },
            ],
          },
          state: {
            assistantContent: '',
            toolCalls: [],
            serverToolResults: [],
          },
        },
      },
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: [] },
        persona: null,
      },
      { type: 'ag_ui_text_message_start', messageId: 'assistant:final:test-run', role: 'assistant' },
      { type: 'ag_ui_text_message_content', messageId: 'assistant:final:test-run', delta: 'Hello' },
      { type: 'ag_ui_text_message_content', messageId: 'assistant:final:test-run', delta: ' threaded' },
      { type: 'ag_ui_text_message_content', messageId: 'assistant:final:test-run', delta: ' world' },
      { type: 'ag_ui_text_message_end', messageId: 'assistant:final:test-run' },
      { type: 'ag_ui_run_finished', run },
    ])

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('conversationId=thread-remount') && (!init?.method || init.method === 'GET')) {
        return historyResponse.clone()
      }

      return ndjsonResponse([
        {
          type: 'session_info',
          capabilities: { thinking: false, streaming: true, tools: [] },
          persona: null,
        },
        ...agUiTextEvents('noop'),
      ])
    }

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatProvider baseUrl="http://localhost/chat">{children}</ChatProvider>
    )

    const first = renderHook(
      () => useChat({ conversationId: 'thread-remount', pipeline: 'full' }),
      { wrapper },
    )

    await waitFor(() => {
      expect(first.result.current.messages.length).toBe(2)
    }, { timeout: 5000 })

    expect(first.result.current.session.state.messages.length).toBe(2)
    expect(first.result.current.session.state.finalizedParts).not.toEqual({})

    first.unmount()

    const second = renderHook(
      () => useChat({ conversationId: 'thread-remount', pipeline: 'full' }),
      { wrapper },
    )

    await waitFor(() => {
      expect(second.result.current.messages.length).toBe(2)
    }, { timeout: 5000 })

    expect(second.result.current.session.state.messages.length).toBe(2)
    expect(second.result.current.session.state.finalizedParts).not.toEqual({})
  })

  it('hydrates messages with explicit transforms after remount with the same conversationId', async () => {
    const historyResponse = ndjsonResponse([
      {
        type: 'ag_ui_checkpoint',
        checkpoint: {
          run,
          messages: {
            messages: [
              {
                id: 'user-1',
                role: 'user',
                content: 'hello threaded world',
              },
            ],
          },
          state: {
            assistantContent: '',
            toolCalls: [],
            serverToolResults: [],
          },
        },
      },
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: [] },
        persona: null,
      },
      { type: 'ag_ui_text_message_start', messageId: 'assistant:final:test-run', role: 'assistant' },
      { type: 'ag_ui_text_message_content', messageId: 'assistant:final:test-run', delta: 'Hello threaded world' },
      { type: 'ag_ui_text_message_end', messageId: 'assistant:final:test-run' },
      { type: 'ag_ui_run_finished', run },
    ])

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('conversationId=thread-remount-explicit') && (!init?.method || init.method === 'GET')) {
        return historyResponse.clone()
      }

      return ndjsonResponse([
        {
          type: 'session_info',
          capabilities: { thinking: false, streaming: true, tools: [] },
          persona: null,
        },
        ...agUiTextEvents('noop'),
      ])
    }

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatProvider baseUrl="http://localhost/chat">{children}</ChatProvider>
    )

    const first = renderHook(
      () => useChat({ conversationId: 'thread-remount-explicit', transforms: [] }),
      { wrapper },
    )

    await waitFor(() => {
      expect(first.result.current.session.state.messages.length).toBe(2)
    })

    first.unmount()

    const second = renderHook(
      () => useChat({ conversationId: 'thread-remount-explicit', transforms: [] }),
      { wrapper },
    )

    await waitFor(() => {
      expect(second.result.current.session.state.messages.length).toBe(2)
    })
  })

  it('hydrates session state after remount with the same conversationId', async () => {
    const historyResponse = ndjsonResponse([
      {
        type: 'ag_ui_checkpoint',
        checkpoint: {
          run,
          messages: {
            messages: [
              {
                id: 'user-1',
                role: 'user',
                content: 'hello threaded world',
              },
            ],
          },
          state: {
            assistantContent: '',
            toolCalls: [],
            serverToolResults: [],
          },
        },
      },
      {
        type: 'session_info',
        capabilities: { thinking: false, streaming: true, tools: [] },
        persona: null,
      },
      { type: 'ag_ui_text_message_start', messageId: 'assistant:final:test-run', role: 'assistant' },
      { type: 'ag_ui_text_message_content', messageId: 'assistant:final:test-run', delta: 'Hello' },
      { type: 'ag_ui_text_message_end', messageId: 'assistant:final:test-run' },
      { type: 'ag_ui_run_finished', run },
    ])

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('conversationId=session-remount') && (!init?.method || init.method === 'GET')) {
        return historyResponse.clone()
      }

      return ndjsonResponse([
        {
          type: 'session_info',
          capabilities: { thinking: false, streaming: true, tools: [] },
          persona: null,
        },
        ...agUiTextEvents('noop'),
      ])
    }

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatProvider baseUrl="http://localhost/chat">{children}</ChatProvider>
    )

    const first = renderHook(
      () => useChatSession({ conversationId: 'session-remount', transforms: [] }),
      { wrapper },
    )

    await waitFor(() => {
      expect(first.result.current.state.messages.length).toBe(2)
    })

    first.unmount()

    const second = renderHook(
      () => useChatSession({ conversationId: 'session-remount', transforms: [] }),
      { wrapper },
    )

    await waitFor(() => {
      expect(second.result.current.state.messages.length).toBe(2)
    })
  })
})
