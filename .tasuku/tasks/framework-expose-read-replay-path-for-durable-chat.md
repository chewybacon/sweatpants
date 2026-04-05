---
status: ready
tags: [framework, api, durable]
parent_id: prototype-threaded-durable-chat
created_at: 2026-04-04T11:15:00.004079Z
updated_at: 2026-04-04T11:15:17.398197Z
---

# Framework: expose durable read/replay path for chat


## Notes

### 2026-04-04T11:15:17Z [6490b8]
Expose a first-class replay/read path for durable chat aligned with offset/LSN semantics. Avoid inventing a second transcript protocol in yo-chat.

