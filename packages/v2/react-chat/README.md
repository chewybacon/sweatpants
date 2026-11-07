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
or global plugin registry is included. SSR/hydration and Vue/Svelte/native
integrations have not been validated. Server rendering needs an application-prepared
snapshot; the hook does not fetch during render.

## Typed elicitation rendering

`createReactElicitHost(runtime)` binds existing tool plugin declarations and scoped
responders to a session-local React presentation store. The concrete component's
`onRespond` parameter determines `render`'s return type:

```tsx
const host = createReactElicitHost(runtime);
const plugin = host.definePlugin(chooseFlight).onElicit({
  *pickSeat(args, ctx) {
    const value = yield* ctx.render(SeatPicker, args.context);
    return { ok: true, value };
  },
});
const responder = host.bindPlugin(plugin);
// Session owner runs responder.operations.respond(selection, interaction).
// The same plugin.support advertises the elicits this frontend handles.
```

`SeatPicker` declares `onRespond: (seat: "2A" | "2B") => void`; the host supplies
that callback, and `value` infers as `"2A" | "2B"`. Props and the declared elicit's
reply remain checked. Existing `defineElicitPlugins<ReactElicitCapabilities<Y>>()`
can also declare plugins separately from a host; `bindPlugin` supplies a session's
capabilities through `createElicitResponder`, including its existing scoped middleware.

```tsx
<ElicitViews host={host} execution={executionId} />
```

The optional filter selects one execution; omitting it displays all active slots.
`ElicitRenderSource` is the subscription contract for custom presentation. Snapshot
references are stable between updates. Listeners must not throw; consumers must not
mutate snapshots. React nodes are frontend-local and never serialized into history.
`ElicitViews` is a live client surface; SSR/hydration is not supported for it.

The calling operation owns each render's lifetime. The first response settles it;
completion or cancellation removes the slot and makes stale callbacks inert. Multiple
views and StrictMode only subscribe: unmount does not cancel the handler. A duplicate
active render for the same execution/request/resolution rejects without removing the
original. This does not deduplicate handler work before `render`.

The host does not start handlers, dispatch snapshots, submit answers, retry delivery,
or establish durable acceptance. The flight frontend continues to own those policies.
Selecting a response completes local UI work; only the server's accepted receipt
establishes the answer. Accepted-history presentation comes from the conversation
view, not retained live React nodes. Completed-component replay, progressive Markdown,
and a general nested render pipeline remain separate work.
