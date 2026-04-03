import { useCallback, useMemo, useState } from 'react'

import type { ConversationEvent, ConversationMessageInput } from './event-types.ts'
import {
  applyConversationEvent,
  createReducedConversationState,
  type ReducedConversationState,
} from './client-reducer.ts'

export interface DurableConversationClient {
  createConversation: (conversationId: string) => Promise<void>
  post: (conversationId: string, body: unknown) => Promise<Response>
  read: (conversationId: string, offset?: string, live?: boolean) => Promise<Response>
}

export interface DurableConversationHookOptions {
  client: DurableConversationClient
  conversationId: string
}

export interface DurableConversationHookValue {
  events: ConversationEvent[]
  reduced: ReducedConversationState
  nextOffset: string | null
  appendMessages: (messages: ConversationMessageInput[]) => Promise<void>
  replayFromOffset: (offset?: string) => Promise<void>
}

interface EventFrame {
  offset: string
  event: ConversationEvent
}

function parseNDJSON(text: string): EventFrame[] {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }
  return trimmed.split('\n').map((line) => JSON.parse(line) as EventFrame)
}

export function useDurableConversation(
  options: DurableConversationHookOptions,
): DurableConversationHookValue {
  const { client, conversationId } = options
  const [events, setEvents] = useState<ConversationEvent[]>([])
  const [nextOffset, setNextOffset] = useState<string | null>(null)

  const ingestResponse = useCallback(async (response: Response) => {
    const text = await response.text()
    const frames = parseNDJSON(text)
    if (frames.length === 0) {
      const headerOffset = response.headers.get('Stream-Next-Offset')
      if (headerOffset) {
        setNextOffset(headerOffset)
      }
      return
    }

    setEvents((previous: ConversationEvent[]) => [...previous, ...frames.map((frame) => frame.event)])
    setNextOffset(frames[frames.length - 1]?.offset ?? response.headers.get('Stream-Next-Offset'))
  }, [])

  const appendMessages = useCallback(
    async (messages: ConversationMessageInput[]) => {
      const response = await client.post(conversationId, { messages })
      await ingestResponse(response)
    },
    [client, conversationId, ingestResponse],
  )

  const replayFromOffset = useCallback(
    async (offset?: string) => {
      const response = await client.read(conversationId, offset, false)
      await ingestResponse(response)
    },
    [client, conversationId, ingestResponse],
  )

  const reduced = useMemo(
    () => events.reduce(applyConversationEvent, createReducedConversationState()),
    [events],
  )

  return {
    events,
    reduced,
    nextOffset,
    appendMessages,
    replayFromOffset,
  }
}
