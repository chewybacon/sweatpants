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

## Register a tool UI and choose its placement

```tsx
const cardUI = defineToolUI(pickCard, {
  chooseCard: ({ input, respond, disabled, outcome }) => (
    <CardChoices
      cards={input.cards}
      disabled={disabled}
      selected={outcome?.ok ? outcome.value : undefined}
      onChoose={respond}
    />
  ),
});

// The application supplies a transport-independent presentation source.
<ToolUIProvider source={presentation} plugins={[cardUI]}>
  <ToolOutlet />
</ToolUIProvider>;
```

The declaration infers each component's input and response from the authored tool.
`submitted` contains the original response input; `outcome` contains the accepted,
schema-transformed result. Renderers must not transform accepted results again.
`state` reports the last observed question state: pending, answered, cancelled or failed.
`delivery` independently reports local answer delivery: idle, sending or unconfirmed.
`disabled` comes from the source's `canRespond` policy, not from either state alone.
For example, a pending question can be disabled while another command is unresolved;
an accepted answer can be observed while its local delivery is still finishing.
Idle delivery does not prove acceptance. These are rendering facts, not a prescribed
transition sequence or authority to answer. A domain decline is
an error Outcome, not workflow cancellation.

A conversation adapter supplies the same `ToolPresentationSource`: a stable snapshot
and subscription over its validated question history and receiver-bound commands.
The source supplies schema-decoded context, accepted Outcomes, and invocation/question
identities. It owns delivery policy; renderer registration does not validate an
arbitrary source or confer answer authority. The flight-chat acceptance consumer
adapts its existing conversation vocabulary and renders each question with
`<ToolOutlet question={part.id} />` inside the message tree. Surrounding text, nested
sampling, tool progress and results remain in that tree.

For an external surface, select `placement={(question) => question.state === "pending"
? "sidebar" : "inline"}` on the provider and render `<ToolOutlet placement="sidebar" />`
in the sidebar. Keep one matching outlet per destination/selector; registration does
not enforce exclusive ownership between duplicate outlets. Placement only selects
where a question appears. Moving/unmounting an outlet never answers, starts, cancels
or closes its source. The owner still chooses when to connect, refresh and retry.

Applications reconstruct answered components from their accepted history. Connection,
command retention and retries belong to their client/transport assembly; this package
exports no standalone-tool lifecycle hook. `createReactElicitHost` remains available
for generator handlers that need multiple renders or other scoped work. Those live
render slots and durable question presentation have different lifetimes; neither runs
the other's handlers.

Sources omit `decline` when domain failure answers are unsupported. A renderer can
conditionally offer it with `decline && ...`; its argument still has the authored
failure type. An accepted decline is `state: "answered"` with `outcome.ok === false`,
not cancellation or delivery failure. Calls revalidate current session availability;
stale callbacks are inert. Awaiting `respond` or `decline` does not establish acceptance:
render accepted results from `outcome`, and uncertainty from `delivery`/`error`.
Unknown programs and effects render a status fallback without hiding other questions.
An outlet renders nothing when placement selects another destination; the application
must provide that destination's outlet.
