# Public framework acceptance

Start iterating from
[`react-plugin.acceptance.test.tsx`](./__tests__/application-composition/react-plugin.acceptance.test.tsx).
It authors a public client, application, tool and elicitation plugin, then exercises
them through real HTTP with a protocol-controlled external model.

## Execution is the configuration point

Authoring tests select the test runtime:

```ts
createChatApp({
  // application identity, storage, model and setup
  tools: [bookTrip],
  execution: testToolRuntime(),
});
```

[`testToolRuntime`](./support/test-tool-runtime.ts) implements the same execution
adapter contract as `local`. It uses the existing local invocation resource
factory without a worker: authored tool bodies, parameter validation, typed
elicitation, nested sampling and lifecycle run through the real invocation
engine in the host process. It supplies no scripted tool results or alternate
client/server behavior. This adapter currently supports ordinary authored tools;
durable program placement must be configured explicitly.

Worker-specific tests configure placement explicitly:

```ts
execution: local({
  worker: resolve("__tests__/tool-runtimes/local-worker/fixtures/tool-worker.mjs"),
});
```

```text
acceptance/
  __tests__/
    application-composition/                               # public client/tool/plugin authoring
    recovery/                                              # replay, replacement, disconnects
    host-crash/                                             # real SIGKILL + SQLite recovery
    tool-runtimes/
      in-process/execution.acceptance.test.tsx                # actual host-thread execution
      local-worker/exchange.acceptance.test.tsx               # off-thread execution and exchanges
      local-worker/fixtures/tool-worker.{ts,mjs}
      agentcore/                                             # deterministic remote driver contract
      cloudflare/                                            # real local workerd + Durable Objects
  fixtures/
    book-trip.ts           # one definition used by either runtime and the plugin
    trip-chat.tsx          # authored plugins and useChat component
    confirmed-trip.ts     # two local steps, one transformed elicitation response
    execution-location.ts  # runtime placement probe
  support/
    test-tool-runtime.ts   # in-process execution adapter
    ui.tsx                # public client + example UI with scoped cleanup
    dom.tsx               # mounting, DOM readiness and cleanup
    controlled-scheduler.ts # deterministic client pull release
```

The React suite’s ten authoring cases cover booking with flight/seat choices and nested
sampling, streaming and follow-up history, stop and resend, provider-error
recovery, authored decline/cancel responses, pending-choice interruption, and
fresh-client recovery. The booking case also sends a successor after tool
completion and checks render identity and message states. Runtime suites add focused
placement evidence without repeating the whole authoring matrix. The worker
cases prove execution off the main thread, typed elicitation/sample/result
exchange, cancellation of a parked invocation, and fresh-client recovery.
They also cover worker loss, durable attachment lifecycle, cancellation
drainage, and indeterminate external effects. AgentCore has deterministic
adapter conformance; Cloudflare uses real local workerd for Dynamic Workers
and Durable Object session/replay contracts.

## Run

```sh
pnpm test:acceptance  # all authoring, recovery, runtime and host-crash cases
pnpm check:acceptance
```

There are no separate public lane commands. During implementation a specific
file can be passed directly to Vitest. The complete package remains the single
acceptance command and is included in landing's package test stage.

See [COVERAGE.md](./COVERAGE.md) for guarantees, exclusions and the deletion ledger.

## Test authoring

Arrange each test with the authored plugins:

```ts
using ui = yield * useUI(rig, { plugins: [tripPlugin] });
```

`useUI` creates the public client and mounts `TripChat`. It defaults to thread
`trip` and API `/assistant/chat`; both can be overridden. `using` unmounts the UI,
and the Effection scope awaits client cleanup. The client is available as
`ui.client` for direct observation.

Use Effection generators with Arrange / Act / Assert sections. Keep interactions,
model responses and assertions visible in the test body, separated by whitespace
and short comments. Inspect actual wire items without history normalization.
The Test Rig conversation/turn facade is not used. DOM support waits on
mutations without sleeps or polling loops; it does not send messages, click
controls or assert behavior.

Cloudflare Worker fixtures have a separate typecheck to keep their runtime
globals separate from React/Node fixtures. Both typechecks run through
`pnpm check:acceptance`.

Strict typechecks resolve `development` source exports, so they do not require
a prior Test Rig build. Executable tests and workers resolve built exports from
`dist`; rebuild changed framework dependencies before running. These are deterministic HTTP/jsdom
acceptance checks, not browser-presentation or live-provider certification.

## First lifecycle migration

The booking case now also checks completed render identity, pending/completed
message states, disabled send while awaiting the final answer, idle authority,
and a successful successor. Two further cases cover parked-choice interruption
and recovery in a new client. The worker lane retains those lifecycle guarantees
with real off-thread execution.

The lifecycle cases replace six binding-expanded cases formerly in
`packages/react-chat/acceptance/hook-state.acceptance.test.ts`. The second pass
moves that file's remaining three cases here: controlled scheduler batching,
and multi-step plugin projection with both in-process and worker execution.
The projection cases verify two local renders within one elicitation, stable
render identity, one final transformed response, Markdown rendering, and
protocol conformance. The old hook harness, application and worker fixtures
have been removed. StrictMode and rendering-pipeline tests remain package-owned.

The in-process bridge uses each tool's authored elicitation input projection,
matching the worker adapter. Response schemas with transforms therefore keep
their declared wire shape and validate/transform the accepted result at runtime.

## Host crash boundary

[`__tests__/host-crash/`](./__tests__/host-crash/README.md) is the explicit home
for application-process crash tests and their child-host fixtures. They
kill a real host with `SIGKILL` and recover over retained SQLite storage.
Graceful host replacement and tool-worker loss have separate ownership.
The implemented crash test runs through `pnpm test:acceptance` with every other
case. It observes actual effect executions across both process generations.
