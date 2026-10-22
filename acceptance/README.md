# Public React application acceptance

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
    application-composition/react-plugin.acceptance.test.tsx  # 8 authoring cases
    tool-runtimes/
      in-process/execution.acceptance.test.tsx                # actual host-thread execution
      local-worker/exchange.acceptance.test.tsx               # off-thread execution and exchanges
      local-worker/fixtures/tool-worker.{ts,mjs}
  fixtures/
    book-trip.ts           # one definition used by either runtime and the plugin
    trip-chat.tsx          # authored plugin and useChat component
    execution-location.ts  # runtime placement probe
  support/
    test-tool-runtime.ts   # in-process execution adapter
    ui.tsx                # public client + example UI with scoped cleanup
    dom.tsx               # mounting, DOM readiness and cleanup
```

The eight authoring cases cover booking with flight/seat choices and nested
sampling, streaming and follow-up history, stop and resend, provider-error
recovery, authored decline/cancel responses, pending-choice interruption, and
fresh-client recovery. The booking case also sends a successor after tool
completion and checks render identity and message states. Runtime suites add focused
placement evidence without repeating the whole authoring matrix. The worker
cases prove execution off the main thread, typed elicitation/sample/result
exchange, cancellation of a parked invocation, and fresh-client recovery.
They retain the worker guarantees of the migrated React lifecycle cases; they
are not a complete worker-failure matrix.

## Run

From the repository root:

```sh
pnpm -C acceptance test:authoring  # fast authoring loop
pnpm -C acceptance test:runtimes   # focused placement contracts
pnpm test:acceptance              # all 12 cases; also used by landing
pnpm check:acceptance
pnpm -C acceptance test:watch __tests__/application-composition
```

## Test authoring

Arrange each test with the authored plugins:

```ts
using ui = yield * useUI(rig, { plugins: [tripPlugin] });
```

`useUI` creates the public client and mounts `TripChat`. It defaults to thread
`trip` and API `/assistant`; both can be overridden. `using` unmounts the UI,
and the Effection scope awaits client cleanup. The client is available as
`ui.client` for direct observation.

Use Effection generators with Arrange / Act / Assert sections. Keep interactions,
model responses and assertions visible in the test body, separated by whitespace
and short comments. Inspect actual wire items without history normalization.
The Test Rig conversation/turn facade is not used. DOM support waits on
mutations without sleeps or polling loops; it does not send messages, click
controls or assert behavior.

Tests and workers resolve built package exports from `dist`; rebuild changed
framework dependencies before running. These are deterministic HTTP/jsdom
acceptance checks, not browser-presentation or live-provider certification.

## First lifecycle migration

The booking case now also checks completed render identity, pending/completed
message states, disabled send while awaiting the final answer, idle authority,
and a successful successor. Two further cases cover parked-choice interruption
and recovery in a new client. The worker lane retains those lifecycle guarantees
with real off-thread execution.

These replace six binding-expanded lifecycle cases formerly in
`packages/react-chat/acceptance/hook-state.acceptance.test.ts`. That file retains
controlled scheduler batching and two protocol/plugin projection cases, including
two local renders within one elicitation and response-schema transformation.
StrictMode and rendering-pipeline coverage remain package-owned.
