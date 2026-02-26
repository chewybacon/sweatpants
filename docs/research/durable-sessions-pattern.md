# Durable Sessions Pattern for Collaborative AI

Research notes on the Durable Sessions pattern as described in the [ElectricSQL blog post](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai).

**Date**: 2026-02-26  
**Related**: [Durable Streams Protocol Alignment](./durable-streams-protocol-alignment.md)

---

## Overview

Durable Sessions is a **state management pattern** that makes AI and agentic apps collaborative by multiplexing AI token streams with structured state into a persistent, resilient, shared session.

The pattern addresses the limitation of current AI SDKs which are designed around single-user <> single-agent request/response interactions.

---

## The Problem: Single-User Paradigm

Current AI SDKs (Vercel AI SDK, TanStack AI) default to:

```typescript
const { messages, sendMessage } = useChat({...})
```

This fails to support collaboration because:
- Local message state isn't shared across users/tabs/devices
- Request/response model blocks UI, assumes single user waiting
- Session state is ephemeral, lost on disconnect
- No standard protocol for persistence and addressability

---

## The Solution: Sync-Based Architecture

Replace request/response with **persistent, subscribable sessions**:

```
┌─────────────────────────────────────────────────────────────────┐
│                     DURABLE SESSION                              │
│              (Persistent, Addressable Stream)                    │
└─────────────────────────────────────────────────────────────────┘
         ▲                    ▲                    ▲
         │                    │                    │
    ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
    │ User A  │          │ User B  │          │ Agent   │
    │ (tab 1) │          │ (mobile)│          │ (LLM)   │
    └─────────┘          └─────────┘          └─────────┘
```

Key properties:
- **Persistent** - Survives disconnects, server restarts
- **Addressable** - URL-based, can be shared/bookmarked
- **Subscribable** - Multiple clients subscribe to same stream
- **Multiplexed** - Different data types over single stream

---

## What Gets Multiplexed

A single Durable Session can carry:

| Data Type | Purpose |
|-----------|---------|
| **Whole messages** | Complete chat messages |
| **Token streams** | Active LLM generation chunks |
| **Presence** | Online users, active devices |
| **Agent registration** | Which agents are subscribed |
| **CRDTs** | Typeahead, cursor positions |
| **Binary frames** | Multi-modal data (images, audio) |

Example schema (using Zod):

```typescript
const sessionSchema = createStateSchema({
  chunks: {
    schema: chunkSchema,
    type: 'chunk',
    primaryKey: 'id',
  },
  presence: {
    schema: presenceSchema,
    type: 'presence',
    primaryKey: 'id',
  },
  agent: {
    schema: agentSchema,
    type: 'agent',
    primaryKey: 'agentId'
  },
})
```

---

## Client-Side: TanStack DB Integration

The pattern uses [TanStack DB](https://tanstack.com/db) for client-side state:

### Collections

Stream data routes into reactive collections:

```typescript
const chunksCollection = createLiveQueryCollection({...})
const presenceCollection = createLiveQueryCollection({...})
const agentCollection = createLiveQueryCollection({...})
```

### Derived Views

Efficient live queries using differential dataflow:

```typescript
// Derive messages from chunks (no for loops!)
const messagesCollection = createLiveQueryCollection({
  query: (q) => {
    return q
      .from({ chunk: chunksCollection })
      .groupBy(({ chunk }) => chunk.messageId)
      .select(({ chunk }) => ({
        messageId: chunk.messageId,
        rows: collect(chunk),
      }))
      .fn.select(({ collected }) => materializeMessage(collected.rows))
  }
})
```

### Reactivity

Surgical reactivity via `useLiveQuery`:

```typescript
const ChatMessages = () => {
  const { data: messages } = useLiveQuery(q =>
    q.from({ msg: messagesCollection })
      .orderBy(({ msg }) => msg.createdAt, 'asc')
  )
  return <List items={messages} />
}
```

---

## Write Path: Optimistic Mutations

User actions use TanStack DB optimistic mutations:

```typescript
const sendMessage = createOptimisticAction<MessageActionInput>({
  onMutate: ({ content, messageId, role }) => {
    // Insert optimistic state immediately
    messagesCollection.insert({
      id: messageId,
      role,
      parts: [{ type: 'text', content }],
      isComplete: true,
      createdAt: new Date(),
    })
  },
  mutationFn: async ({ content, messageId, role }) => {
    const txid = crypto.randomUUID()
    
    // POST to backend
    await fetch(`/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messageId, content, role, txid }),
    })
    
    // Wait for write to sync back before discarding optimistic state
    await streamDb.utils.awaitTxId(txid)
  },
})
```

---

## Agent Architecture

Agents are backend API endpoints that subscribe to sessions:

```typescript
// Session backend notifies registered agents
state.modelMessages.subscribeChanges(async () => {
  const history = await this.getMessageHistory(sessionId)
  notifyRegisteredAgents(stream, sessionId, 'user-messages', history)
})
```

Agent endpoint (standard AI SDK code):

```typescript
async ({ request }) => {
  const { messages } = await request.json()
  
  const stream = chat({
    adapter: openai(),
    model: 'gpt-4o',
    systemPrompts: [SYSTEM_PROMPT],
    messages,
  })
  
  return toStreamResponse(stream)
}
```

The session backend consumes agent responses and writes them to the durable stream.

---

## Benefits

### For Users
- Join sessions mid-conversation
- Continue on different devices
- Real-time collaboration with other users
- See agent responses even after disconnect

### For Developers
- Standard state management pattern
- Works with existing AI SDKs
- Minimal component code changes
- Pluggable storage backends

### For Enterprise
- Audit logs and history built-in
- Multi-user access control
- Compliance review of sessions
- Integration with governance systems

---

## Relation to Our Implementation

### What We Have

| Component | Our Implementation | Durable Sessions |
|-----------|-------------------|------------------|
| Token buffer | `TokenBuffer<T>` | Durable Stream |
| Session lifecycle | `SessionRegistry` | StreamDB |
| Pull-based reads | `PullStream` | Collections |
| Wire protocol | NDJSON | Durable State layer |

### What We Could Add

1. **Multiplexed schemas** - Currently single event type per stream
2. **Client-side collections** - TanStack DB integration
3. **Presence tracking** - User online/offline status
4. **Agent registration** - Dynamic agent subscription
5. **Optimistic mutations** - Principled local state management

### Considerations

Our current model is **session-per-chat-request**, where:
- Each chat request creates or resumes a session
- The ChatEngine is the single writer
- Clients read via PullStream

The Durable Sessions pattern is **session-as-shared-workspace**, where:
- Sessions are long-lived, multi-user workspaces
- Multiple writers (users, agents) contribute
- Clients sync via TanStack DB collections

These aren't mutually exclusive - we could evolve toward the full pattern incrementally.

---

## Implementation Path

### Phase 1: Protocol Compliance (Current Focus)
- Align wire protocol with Durable Streams spec
- Add SSE and long-poll modes
- URL-based stream addressing

### Phase 2: Multiplexed Schemas
- Support multiple event types per session
- Schema-aware routing to handlers
- Type-safe event discrimination

### Phase 3: Client Integration
- TanStack DB collection adapters
- Optimistic mutation helpers
- Presence primitives

### Phase 4: Multi-Agent
- Agent registration protocol
- Event-based agent triggers
- Response routing and multiplexing

---

## References

- [Durable Sessions Blog Post](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai)
- [TanStack DB](https://tanstack.com/db)
- [TanStack AI](https://tanstack.com/ai)
- [electric-sql/transport](https://github.com/electric-sql/transport) - Reference implementation
