import { useMemo, useState } from 'react'

import { useDurableConversation, type DurableConversationClient } from './use-durable-conversation.ts'

export interface DurableConversationExampleProps {
  client: DurableConversationClient
  conversationId: string
}

export function DurableConversationExample(
  props: DurableConversationExampleProps,
) {
  const { client, conversationId } = props
  const [draft, setDraft] = useState('')

  const { events, reduced, nextOffset, appendMessages, replayFromOffset } =
    useDurableConversation({
      client,
      conversationId,
    })

  const assistantMessages = useMemo(
    () => reduced.orderedAssistantMessageIds.map((id) => reduced.assistantMessages[id]),
    [reduced],
  )

  return (
    <div>
      <h2>Durable Conversation Example</h2>
      <p>Conversation: <code>{conversationId}</code></p>
      <p>Next offset: <code>{nextOffset ?? 'none'}</code></p>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          const content = draft.trim()
          if (!content) {
            return
          }
          void appendMessages([{ role: 'user', content }])
          setDraft('')
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type a message"
        />
        <button type="submit">Send</button>
        <button
          type="button"
          onClick={() => {
            void replayFromOffset(nextOffset ?? undefined)
          }}
        >
          Replay From Offset
        </button>
      </form>

      <section>
        <h3>Assistant Messages</h3>
        <ul>
          {assistantMessages.map((message) => (
            <li key={message?.id}>
              <strong>{message?.completed ? 'complete' : 'streaming'}:</strong>{' '}
              <span>{message?.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Raw Events</h3>
        <pre>{JSON.stringify(events, null, 2)}</pre>
      </section>
    </div>
  )
}
