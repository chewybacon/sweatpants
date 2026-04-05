---
status: done
tags: [framework, durable, chat]
parent_id: prototype-threaded-durable-chat
created_at: 2026-04-04T11:14:59.909125Z
updated_at: 2026-04-04T11:31:26.599524Z
---

# Framework: durable identity for conversationId


## Notes

### 2026-04-04T11:31:23Z [aaa3c4]
Implemented conversationId-driven durable identity in the handler. POST still creates a new run/session when no sessionId is provided, but GET/HEAD with conversationId now resolve to the latest recorded session for that conversation. Added conversation index storage in packages/framework/src/handler/durable/conversation-index.ts and focused handler coverage.

### 2026-04-04T11:15:17Z [707228]
Make conversationId deterministically address the same durable conversation across sends and refreshes. Keep app-facing identity as threadId === conversationId; keep any per-run session ids transport-internal.

