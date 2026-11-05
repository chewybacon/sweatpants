# yo-chat v2

A separate local reference app using only v2 framework packages. One persistent
text conversation, a React composer, completed model replies and reload recovery.
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

The server admits a submission, explicitly runs its recorded chat turn and waits for
completion before returning a receipt. The model adapter consumes its stream internally;
this slice displays the completed response, not token deltas. SQLite retains accepted
history and stable message IDs. A second turn receives the prior accepted transcript.

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
user message in history alone is not proof that its turn completed.

The server owns started model work even when an HTTP client disconnects. Shutdown
closes active HTTP sockets and cancels/joins application tasks before closing SQLite.
Node already closes idle connections when the listener closes; explicit socket closure
also releases incomplete uploads. No `process.exit()` bypasses task cleanup. Shutdown
preserves uncertain journal attempts rather than pretending remote work was cancelled.
The busy flag is process-local; run one server per database. Concurrent submission is rejected while a
turn advances. A lost receipt can be recovered by resubmitting the same command; an
uncertain model attempt remains occupied and is never automatically retried. A running
status after restart can mean unresolved work, not a currently active model request.
There is no automatic reconciliation or repair UI in this first slice. A credential
revoked after startup can still leave such a turn unresolved: the SDK combines auth,
network, interrupted-stream and other failures into generic error events, and the
adapter supplies no typed proof of non-delivery. Do not classify these by message text.
Supporting recovery needs structured provider failure evidence and an explicit terminal
failure/continuation policy; merely returning `ok: false` does not establish either.

The server binds to loopback, checks Host and same-origin POST requests, accepts bounded
JSON bodies and exposes only text projections. It has no user authentication or tenant
isolation and is not a deployment-ready multi-user service. Keep a conversation's model
configuration stable; foreign reasoning compatibility is not silently selected.

## Validation and next slices

`pnpm land` includes this app's lint, formatting, typecheck and browser build. The v2
acceptance journey imports the real app, HTTP Request/Response handler, browser transport
and React UI. Both runtimes cover lost acknowledgement, identical retry without another
model call, SQLite reopen, multi-turn history, stale predecessors, concurrent submission
and preservation of uncertain attempts, including physical shutdown. The stale-tab
journey verifies draft editing and explicit resubmission while lost receipts retain
identical retry. A second journey exercises the actual Node listener on an ephemeral
loopback port: Host/Origin/body-size checks, assets from a different working directory,
active upload closure and model cleanup before SQLite close. The no-emit acceptance
config includes the repo root so these tests can import app source. The model peer is
simulated; these tests do not prove live provider credentials or OS-crash durability.
Static assets resolve relative to the server module, independently of the launch directory;
the database and optional environment file remain configured relative to the app command.

Next: live response updates/reconnect, one interactive tool, then conversation listing
and switching. Markdown, reasoning display, stop controls, all v1 demos and deployment
are outside this slice.
