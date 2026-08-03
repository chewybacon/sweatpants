# Demo 1: Reconnect mid-stream

**Claim:** After a streaming reader disconnects mid-turn, server-side work continues. Reconnecting reconstructs the same completed turn projection — no missing assistant content attributable to the disconnect.

**Time:** under 3 minutes · **No Effection literacy required**

## User path

1. Start yo-chat: `pnpm dev:yo-chat:local`
2. Open [Basic Chat](http://localhost:8000/chat/basic/)
3. Send a longer prompt (e.g. “Write a short essay about durable streams”)
4. While `streaming...` is visible, refresh the page
5. Confirm the conversation reloads and the assistant content is complete

Conversation identity is stored in `localStorage` for this demo route.

## Product imports (sample)

```tsx
import { useChat } from "@sweatpants/react-chat";

// useChat reconnects via conversation id + durable handler protocol
const { messages, sendMessage, status } = useChat({
  api: "/api/chat",
  conversationId,
});
```

Server side (happy path):

```ts
import { createChatApplication, createChatHandler } from "@sweatpants/agent-host/server";
```

## Automated gate

```bash
pnpm -C packages/durable-chat-runtime exec vitest run acceptance/demo-reconnect-mid-stream.acceptance.test.ts
```

Classification: **acceptance** (protocol/handler). Reuses durable handler + in-memory streams.
