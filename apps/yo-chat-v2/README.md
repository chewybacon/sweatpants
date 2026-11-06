# yo-chat v2

A separate local reference app using only v2 framework packages. One persistent
conversation, a React composer, live provisional replies, interactive demo flights and
reconnect/reload recovery.
Existing `apps/yo-chat` is unchanged.

## Run

Use the repository's supported Node >=24.22.0 and installed workspace dependencies.
The default chat model is OpenAI `gpt-6-luna` (Luna 6). Configure `OPENAI_API_KEY`
in the server environment. Override `CHAT_PROVIDER` and `CHAT_MODEL` to select another
model from the installed Pi catalog with its corresponding provider credential. Credentials
stay on the server; this app does not read v1's credential file or start a login flow.

```sh
pnpm --filter yo-chat-v2 dev
```

Startup resolves provider authentication before opening SQLite or accepting a turn.
Missing credentials stop startup with a setup error rather than reserving an uncertain turn.
This checks authentication configuration, not live model access.

For CLI Proxy API, set `OPENAI_BASE_URL` to its `/v1` endpoint and
`OPENAI_API_KEY` to the proxy credential. The OpenAI catalog entries and SDK driver
both use that endpoint. The server loads optional `.env.local` in the app directory;
this file is git-ignored and must never be committed. Shell environment values take
precedence. Luna remains `gpt-6-luna` when the proxy advertises that model ID.

Open http://localhost:8001. `dev` typechecks and builds the browser bundle, then starts
the local Node server; rerun after changes (no hot reload yet). `PORT` changes the port.
`CHAT_DATABASE` changes the default `data/chat.sqlite` path, relative to the app's
working directory. The default data directory is created automatically. This app uses
its own database and never opens or migrates v1 chat data.

## Behavior and ownership

The server admits a submission and returns HTTP 202 with its receipt independently of
execution completion. An identical retry returns the admission receipt even while the
turn is active or unresolved; a receipt does not claim that the model succeeded. The
application owns the recorded turn's execution. A second turn receives only the prior
accepted transcript.

The model adapter exposes one stream of cumulative public text followed by its terminal
sample. The Host drains that stream, retaining provisional text in an app-local SQLite
projection keyed by execution. Reasoning is not published. Provisional and accepted text
use the same stable message/part IDs; accepted journal results replace the preview and
mark it complete. A retained preview never supplies model history or journal authority.
Shutdown/reopen can retain unfinished text without pretending its turn completed.

`GET /api/conversation/changes` is a read-only NDJSON stream of coalesced change hints.
Each connection begins with a hint; the browser then refreshes the complete view from
`GET /api/conversation`. A slow observer may skip intermediate previews, but cannot miss
the current text. Repeated hints replace the view rather than append duplicate deltas.
There is no token event log or cursor: reconnect and reload reconstruct the complete
projection, then follow changes. This intentionally trades extra snapshot reads for a
small protocol. It does not establish efficient paging for large conversations.

The application calls `client.connect()` once. It owns the observation loop and retries
failed connections with bounded backoff (250ms to 2s), without resubmitting commands.
`disconnect()` aborts and joins observation; `close()` releases the local client. Neither
cancels execution. React consumers only subscribe, so mounting/unmounting them does not
own transport or model work. The page owner disconnects on pagehide and reconnects on
pageshow. Status and activity describe the last observed server view, not a heartbeat.

The browser creates one shared client and supplies it through an application provider.
Messages and Composer independently call `useChat()`. New-message `submit` is an
application command, separate from the framework's tool-answer capability. Retry keeps
the same submission ID, text and predecessor. A refresh reads retained state without
running the model. An unconfirmed submission stays available for identical retry in
the current page; reloading discards that local retry form and recovers server history.
Definitive stale-predecessor, incomplete-predecessor and conflicting-command rejections
carry a typed `not-admitted` response for the submitted tuple. They unlock the draft
without silently resubmitting it. Busy responses, malformed responses and transport
failures do not prove non-acceptance and retain the exact pending command. Seeing a
user message in history alone is not proof of command acknowledgement or turn completion.

The server owns started model work even when an HTTP client disconnects. Shutdown
closes active HTTP sockets and cancels/joins application tasks before closing SQLite.
Node already closes idle connections when the listener closes; explicit socket closure
also releases incomplete uploads. No `process.exit()` bypasses task cleanup. Shutdown
preserves uncertain journal attempts rather than pretending remote work was cancelled.
Admission serialization and notifications are process-local; run one server per database.
A new turn requires a completed predecessor, while duplicate submissions can recover
the same admission receipt during active execution. A lost receipt can be recovered
by resubmitting the same command; an
uncertain model attempt remains occupied and is never automatically retried. A running
status after restart can mean unresolved work, not a currently active model request.
There is no automatic reconciliation or repair UI in this first slice. A credential
revoked after startup can still leave such a turn unresolved: the SDK combines auth,
network, interrupted-stream and other failures into generic error events, and the
adapter supplies no typed proof of non-delivery. Do not classify these by message text.
Supporting recovery needs structured provider failure evidence and an explicit terminal
failure/continuation policy; merely returning `ok: false` does not establish either.

The Node listener forwards response bodies with backpressure and cancels the reader
when its socket closes. Reader cleanup does not cancel production. The server binds
to loopback, checks Host and same-origin POST requests, accepts bounded JSON bodies
and exposes validated conversation and flight-question projections. It has no user authentication or tenant
isolation and is not a deployment-ready multi-user service. Keep a conversation's model
configuration stable; foreign reasoning compatibility is not silently selected.

## Validation and next slices

`pnpm land` includes this app's lint, formatting, typecheck and browser build. The v2
acceptance journey imports the real app, HTTP Request/Response handler, browser transport
and React UI. Both runtimes cover lost acknowledgement, identical retry without another
model call, SQLite reopen, multi-turn history, stale predecessors, concurrent submission
and preservation of uncertain attempts, including physical shutdown. Streaming journeys
exercise the real app model adapter with a scripted provider stream: early admission,
provisional text, reasoning exclusion, final replacement, duplicate notifications,
automatic reconnect, reload mid-response, two independent clients and two React
consumers sharing one client. Disconnect/unmount leave production alive; reopened
SQLite retains provisional text without authorizing redispatch. The stale-tab
journey verifies draft editing and explicit resubmission while lost receipts retain
identical retry. A second journey exercises the actual Node listener on an ephemeral
loopback port: Host/Origin/body-size checks, assets from a different working directory,
actual streaming response delivery and socket disconnects, active upload closure and
model cleanup before SQLite close. The no-emit acceptance
config includes the repo root so these tests can import app source. The model peer is
simulated; these tests do not prove live provider credentials or OS-crash durability.
Static assets resolve relative to the server module, independently of the launch directory;
the database and optional environment file remain configured relative to the app command.

Next: conversation listing and switching, richer tool history and handler registration DX.
Markdown, reasoning display, stop controls, all v1 demos and deployment remain outside
this slice.

## Pick a demo flight

Ask “Help me pick a demo flight to LAX.” Luna can call `choose_flight`, which offers
fictional flight cards followed by a seat choice. No real search, booking, reservation
or payment takes place. The final selection is recorded and rendered under the
assistant reply. Reloading while either question is pending restores its picker.

The app owns one `createFlightFrontend` session and passes it through ChatProvider.
Its typed handlers use `(args, ctx)` and `yield* ctx.render(...)`. The page starts the
session once; React subscribers do not own handler tasks. Full snapshots reconcile
exact execution/request/resolution identities, deduplicate local handlers and stop
obsolete renders. Pagehide cancels local tasks; server questions remain parked.
A lost answer receipt retains the identical command for explicit “Retry same answer”
while that question is still pending. A refreshed view replaces obsolete UI. No
handler lease across tabs or durable browser outbox is provided.

The frontend advertises its handler support with new submissions. The server selects
only its permitted demo tool when all declared elicits are covered, and retains that
selection in admission input. Retry identity includes the support advertisement.
`POST /api/conversation/answers` validates the envelope, resolves the root within the
conversation, verifies question kind against the persisted grant and accepts the
answer. The app then explicitly advances that root; the framework answer operation
itself does not run work. No client can add arbitrary tools to the server inventory.
The prior text program remains available for existing history; tool-enabled turns use
a separate program ID and rebuild their catalog from retained admission.

Typed elicit declarations, support selection, responder APIs and selected-handler
middleware now come from @sweatpan.ts/tools. The app binds declarations to its React
capabilities through createElicitResponder. React rendering and session dispatch remain
provisional application APIs; acceptance imports that assembly here. The demo tool's source declaration is intentionally browser-safe;
it contains no server imports or credentials. General contract extraction remains
unimplemented. The browser build externalizes Effection's dormant `node:process`
import for main(); the app never calls main(), and tree shaking removes that import
from the emitted browser bundle.

`yo-chat-v2-flight.acceptance.test.tsx` covers the actual HTTP transport, provider UI,
SQLite reopen while waiting, repeated snapshots, client disposal, an answer lost
before delivery, identical retry and a receipt lost after acceptance on both runtimes.
The model peer is scripted. Live-browser verification and its scope are recorded in
the workspace handoff rather than treating simulated tests as live-provider evidence.

## Model-authored Lua code mode

Select **Use code mode**, then ask to pick a demo flight. The model receives
`run_lua({source, input?, validateOnly?})` with language guidance derived from the
selected flight binding. A typical program is `return choose_flight(input)` with
`input: {destination: "LAX"}`. Only a frontend advertising both flight elicits
makes that capability available. Plain Lua computation remains available without
flight support. The default direct-tool mode and prior program IDs still work.

The outer chat catalog retains selected flight bindings for descendant discovery
and exact-answer validation. Sampling advertises only run_lua. The catalog is an
application-permitted inventory, not solely a list of model-visible entry points;
a fabricated direct flight call can still select that already-permitted binding.
Neither hiding a name nor prompt guidance is the authority boundary. The Lua
bridge and Host grant enforce the selected inventory, including direct calls to
workflow.effect. Unknown bindings and malformed demo requests become failures
before any child is created.

The root retains mode and selected elicit routes; each owned code child retains
source, input and validateOnly on its parent link. These are immutable invocation
inputs to the versioned code-tool program, whose implementation pins the prelude,
VM protocol and decoder meanings. No mutable source lookup or plugin revision field.
Changing those semantics requires a new program ID. The code tool uses Kernel
preparation, existing Guests, recovery, owned tool routing and journal acceptance.
A flight call creates its own nested tool child. Answers explicitly advance the
root as in direct-tool mode. This assembly currently uses replay, not checkpoints.

Syntax validation runs before any authored code. validateOnly returns the checks
without executing. Invalid source returns diagnostics to the outer model, which
can explicitly submit corrected source as a new tool call. Known authored failures
return failed results after the VM unwinds. Invalid
capability requests receive a journaled failure Outcome, allowing Lua to handle
the refusal or unwind through its normal cleanup. Accepted earlier tool actions
are not rolled back. No automatic program retry or computation-extension approval
is provided. Loader, ABI and unexpected infrastructure failures remain unresolved under the
existing uncertainty policy. The fixed computation ceiling also leaves the turn
unresolved: forced VM termination is not proof that authored cleanup finished.
Observation/reload does not retry it; operator recovery remains outside this slice.

The UI projects retained code source/results in invocation order and nests pending
flight/seat pickers inside their code run. Observation traverses existing historical
and active child links without acquiring Guests. This bounded-demo full-history scan
is not an optimized history index, atomic tree snapshot or general public message-tree
API. Final flight summaries are shown when the program returns the flight result.
Lua has no host IO/network imports; this is still not a security-audited multi-user
sandbox. Native cancellation cannot interrupt a synchronous Wasm slice.

The application can accept an explicit loadLuaModule loader; the Node default reads
the packaged VM and caches compiled code only. DOM acceptance supplies a file loader
because its browser transform rewrites asset URLs. Both paths execute the real VM.
Acceptance covers syntax repair, validation-only calls, nested questions, SQLite
reopen, lost answer receipts, retained source/results, denied unsupported capabilities,
invalid arguments, authored faults and computation limits on Effect and Effection.
A rejected-request journey also parks and reopens a flight question inside authored
cleanup, then reports failure only after that cleanup completes.
The provider peer is scripted; no live model/browser verification is claimed here.

New code-mode submissions use `code-turn-v2` / `lua-tool-v2` and the opt-in
Piccolo library artifact (`string.sub`, `string.char`, bounded `table.concat`).
Retained `code-turn-v1` executions keep their original tool identity and VM;
reading or retrying old history does not silently upgrade its runtime. Code cards
show the authored result status, including failure, separately from host completion.
