---
status: done
tags: [yo-chat, api, threads]
parent_id: prototype-threaded-durable-chat
created_at: 2026-04-04T11:15:00.050511Z
updated_at: 2026-04-04T12:01:40.217005Z
---

# yo-chat: build thread metadata API


## Notes

### 2026-04-04T12:01:40Z [d3b523]
Implemented a lightweight metadata-only thread API in yo-chat. Added in-memory thread metadata store and CRUD handlers under /api/threaded-chat/threads, and removed the older custom transcript-coupled threaded API. This route now manages ids/titles/previews/timestamps only; transcript durability stays in the framework chat path.

### 2026-04-04T11:15:17Z [863039]
Metadata only: thread id, title, preview, timestamps. Canonical transcript remains in framework durable chat. Default title comes from first user message for now.

