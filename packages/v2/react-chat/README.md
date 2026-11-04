# React chat bindings

Declare a typed context once in an application module. This creates a provider/hook
pair, not a client or conversation:

```tsx
import { createChatContext } from "@sweatpan.tsx/chat";

export const { ChatProvider, useChat } = createChatContext<
  ConversationView,
  AnswerCommand,
  AnswerReceipt
>();
```

Supply the shared client at the session boundary:

```tsx
<ChatProvider client={chat}>
  <Conversation />
  <PendingQuestions />
</ChatProvider>
```

Components subscribe without passing a client or creating a session:

```tsx
function PendingQuestions() {
  const { view, status, error, answer, refresh } = useChat();
  // Render view.questions. Submit with answer(command), then explicitly refresh.
}
```

The hook returns observation state and typed, receiver-bound `answer`/`refresh`
actions. It does not flatten application-specific view fields or invent submission
commands. The application declaration preserves the view/command/receipt types:
React cannot infer those types from a distant provider into a universal hook.
Calling the returned hook without its matching provider throws a descriptive error.
Nested providers select the nearest client; separate context declarations are isolated.
Changing a provider's client switches subscriptions and actions.

The embedding application creates the client, performs initial observation and closes
it when its owner ends. Providers do not create, refresh or close clients; mounting
multiple consumers or React StrictMode does not start work. Unmount only unsubscribes,
leaving other React or non-React observers and server execution alive. Existing pending
commands retain their original client when the provider changes.

For explicit composition without context, the package also exports `useChat(client)`
over the portable `ChatViewSource`. That lower-level hook returns only the snapshot.
Application components normally import the zero-argument hook from their context module.
React 19 is the supported peer.

The file and flight acceptance consumers exercise these bindings with SQLite and both
runtimes. Flight renders messages and questions through independent context subscribers,
with a plain DOM subscriber on the same client. Its journeys cover StrictMode, nested
providers, client replacement and externally owned lifetime.

No provider-owned client lifecycle, automatic startup/retry, optimistic acceptance,
plugin registry or render nodes are included. SSR/hydration and Vue/Svelte/native
integrations have not been validated. Server rendering needs an application-prepared
snapshot; the hook does not fetch during render.
