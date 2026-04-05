---
status: done
tags: [framework, react, durable]
parent_id: prototype-threaded-durable-chat
created_at: 2026-04-04T11:14:59.959371Z
updated_at: 2026-04-04T11:50:15.01421Z
---

# Framework: add durable replay hydration to useChatSession


## Notes

### 2026-04-04T11:50:14Z [527e44]
Implemented initial durable replay hydration in create-session/useChatSession. Sessions with conversationId now fetch prior durable NDJSON history on mount, replay it into reducer state, and seed in-memory message history for subsequent sends. Added helper at packages/framework/src/lib/chat/session/durable-history.ts and focused black-box coverage.

### 2026-04-04T11:15:17Z [d5c8c3]
Hydrate prior durable events into the same patch/reducer pipeline used for live chat so tools, markdown, emissions, handoffs, and elicit state stay consistent with normal useChat behavior.

