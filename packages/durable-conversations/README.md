# @sweatpants/durable-conversations

Spike package for one durable stream per conversation.

This package prototypes:

- `PUT /conversations/{id}` to create a conversation stream
- `POST /conversations/{id}` to append messages and continue flow
- `GET /conversations/{id}?offset=X` to replay from an offset

The spike includes a simple `echo` tool path with an explicit user elicitation round-trip.

## Example React Usage

```tsx
import { DurableConversationExample } from '@sweatpants/durable-conversations'

const client = {
  createConversation: async (conversationId: string) => {
    await fetch(`/conversations/${conversationId}`, { method: 'PUT' })
  },
  post: (conversationId: string, body: unknown) =>
    fetch(`/conversations/${conversationId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  read: (conversationId: string, offset?: string, live?: boolean) => {
    const params = new URLSearchParams()
    if (offset) params.set('offset', offset)
    if (live) params.set('live', 'stream')
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return fetch(`/conversations/${conversationId}${suffix}`)
  },
}

export function App() {
  return (
    <DurableConversationExample
      client={client}
      conversationId="example-conversation"
    />
  )
}
```
