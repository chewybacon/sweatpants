---
status: in_progress
created_at: 2026-04-04T09:30:51.036968Z
updated_at: 2026-04-04T11:15:17.237158Z
---

# Prototype threaded durable chat UI in yo-chat


## Notes

### 2026-04-04T11:15:17Z [2e9acc]
Prototype architecture: keep thread metadata separate from transcript transport. Selected thread mounts useChat({ conversationId: threadId }). Keep threadId === conversationId for the app-facing model.

### 2026-04-04T11:15:17Z [aeac08]
Re-scope this task around a useChat-first threaded prototype. The custom threaded runtime proved the UX shape, but it bypasses reducer-driven state, tools, emissions, pipeline rendering, abort/reset, and durable chat semantics.

