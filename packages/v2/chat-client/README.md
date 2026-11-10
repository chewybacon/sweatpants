# Scoped client capabilities

`createResponseSubscriptions` selects an output source through an ordinary Api;
`createElicitationHandler` supplies a typed client handler without importing an
executable tool definition. Both support `.operations`, `.around`, and `.install`.
These are generic capability contracts, not a complete client session or wire protocol.

Subscriptions retain their acquisition source and scope. Middleware can wrap `next`
for frame observation. Cursor format and source identity belong to the application;
buffer offsets are instance-local, not a persistent log. Disconnecting one reader
must not terminate independently owned production.

Reply caching, reconnect logic, server answer validation and durable deduplication
remain outside the handler facade. Canceling a pending handler releases its own UI
work; an in-memory reply cache does not establish durable exactly-once behavior.

## Observable chat client

`createChatClient({ transport })` is a caller-owned client over an application-defined
public view, command and receipt. Construction is idle. It exposes `getSnapshot()`,
`subscribe(listener)`, `refresh()`, `answer(command)` and `close()`.

```ts
const client = createChatClient({ transport });
const unsubscribe = client.subscribe(() => render(client.getSnapshot()));
await client.refresh();
const receipt = await client.answer(command);
await client.refresh(); // Explicit presentation policy; does not advance execution.
unsubscribe();
client.close();
```

Snapshots keep a stable reference between updates and distinguish observation status
from execution status inside the view. A current read failure retains the old view;
late results from superseded refreshes cannot overwrite newer state. `close()` is
idempotent and discards late observations. It does not own transport shutdown or
server execution, and already-submitted answers may still complete. Commands do not
optimistically change history or retry; a rejected promise may represent lost receipt
acknowledgement. Applications own validation, authorization and receipt recovery.

This external-store subscription reports invalidation of finite observation state.
It is not a producer stream or durable event log. Existing `ResponseSubscriptions`
remain the capability for consuming application-defined streamed response frames.
Listeners must not throw. Only the snapshot wrapper is frozen; transports supply
readonly view data. No polling, pagination, streaming delta protocol or transport
implementation is selected by the client.

## Correlated questions and rendering trees

Declare each question kind together with its context and response:

```ts
type BookingQuestions =
  | { kind: "seat"; context: { seats: readonly string[] }; response: { seat: string } }
  | { kind: "confirm"; context: { itinerary: string }; response: { confirm: true } };

type History = QuestionHistory<BookingQuestions>;
type Command = QuestionAnswer<BookingQuestions, AnswerTarget>;
type Part = ConversationPart<BookingQuestions, BookingResult>;
```

`QuestionContext`, `QuestionHistory` and `QuestionAnswer` derive from that same union.
In an answered `seat` history node, `question.seats` and `response.seat` are both
known without casts. Pending/cancelled nodes cannot contain a response. Commands
keep kind/value correlation, while `AnswerTarget` remains application-defined and
must be checked against server authority. These are TypeScript contracts, not runtime
schemas, credentials or schema registration. Wire decoding still belongs to the app.

`ConversationPart` represents text, messages, tools and questions. Container `parts`
retain nesting; tool result data has its own generic type. `ConversationNode` adds
explicit parent and sibling placement to a flat record. `materializeConversation`
produces a rendering tree, rejecting absent parents, duplicate identities/positions,
non-container parents and unreachable cycles. It never guesses placement from arrival
order. Supply explicit catalog/result type arguments when materializing generic nodes.
`conversationText` concatenates only direct text parts, excluding nested activity.

The tree is a derived public view, not a journal or answer-authority model. Ordering
means causal/sibling placement, not a global chronology of concurrent execution.
Application decoders select safe content and interpret their pinned execution records.
Unknown/malformed payloads require application schema validation; materialization only
validates placement. Generic activity/media, archive anchors and partial-tree updates
are not covered by this small model.

File and flight acceptance journeys use these package exports through React and
non-React consumers. They cover typed command/history rejection at compile time,
answered and cancelled history after SQLite reopen, independent subscriber lifetimes,
lost acknowledgements and overlapping/nested tools. The application decoders and
renderers remain examples; no framework-specific render objects enter the shared view.

## Tool presentation sources

`ToolPresentationSource` is a transport-independent subscription boundary for typed
UI registration. The application supplies stable question snapshots, decoded contexts,
accepted Outcomes and receiver-bound commands. It does not prescribe HTTP methods,
browser storage, retry or connection ownership.

The [standalone example](../../../apps/yo-chat-v2/README.md#standalone-picker-durable-rpc)
composes `createChatClient` with its own HTTP adapter and retained-command policy.
The conversation example uses its own conversation projection. Neither requires a
public tool-specific protocol or a second framework client implementation.

Question snapshots separate durable observation (`state`), local answer delivery
(`delivery`) and current response policy (`canRespond`). A pending question may be
locally unavailable, and an answered question may coexist with an unresolved delivery.
`idle` only means there is no local delivery to report. Sources choose retry and
availability policy; callbacks still validate current identity and authority. Consumers
must not infer permission from state or treat `canRespond` as a durable grant.

Sources publish `outcome` exactly for answered questions and `submitted` whenever
local delivery is sending or unconfirmed. A domain decline is an answered error
Outcome. `unconfirmed` describes missing confirmation, not proof of an error.
`pending` includes blocked work; it is not a promise that this session can advance it.
Unsupported decline commands are absent. Commands revalidate at call time and stale
or disallowed callbacks are inert; a resolved promise does not prove acceptance.

Snapshots stay referentially stable until changed, and subscribers are notified after
publication. Immutable sources can instead be replaced by their owner, provided that
replacement reaches consumers; they need no notifications for internal changes because
they never change internally.
