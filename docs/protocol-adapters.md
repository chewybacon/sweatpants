# Protocol adapters and their boundaries

An adapter translates a boundary and owns its transport lifetime. It does not gain
journal authority simply because it carries a request or retains a live session.
There are several current adapter families; they are not interchangeable execution
engines.

## Local worker Guests

The iterator worker path is:

```text
placement prepares definition identity and input
  → GuestWork acquires a worker Guest
  → start/resume commands cross the worker transport
  → worker advances the tool and returns Turn data
  → host handles JournalRequest and accepts Outcome
  → accepted Outcome returns through resume
```

`createWorkerGuest` and `serveWorkerGuest` carry advancement across worker threads.
The yo-chat worker selects its registered definition by name, version and interface
digest. Acquisition must not advance the authored body. Closing the Guest joins
transport cleanup; it is not a durable cancellation command.

The concrete placement API retains Result inference. The worker registry and wire
payloads are dynamic boundaries: JSON shape, declaration identity and authored
schemas still need validation. A TypeScript cast cannot establish wire correctness.
Transport loss escapes as failure instead of being accepted as authored error data.

## HTTP chat

The primitive chat host validates command envelopes, authorizes conversation access
and owns admission, persistence and projection. Public clients send commands and
consume projected conversation state. Reconnect observes accepted state and pending
interactions; it does not take ownership of a tool continuation.

Provider events are provisional streaming output. The final model response becomes
an accepted journal outcome before the computation resumes. UI rendering and network
delivery are not themselves journal acceptance.

## MCP

`tool-session/src/mcp` retains native-context tool execution, interaction handling,
continuation transport and projection into MCP messages. The bridge uses the
internal compiled factory accessor; it is not the generic iterator journal loop.
MCP elicitation/sampling protocols need their own validation and correlation even
when metadata originates from the same authored definition.

Keep these boundaries explicit when changing shared types. A native MCP session
cannot be replaced by a JSON request union without preserving its continuation,
resource lifetime and reply semantics. Conversely, the existence of retained MCP
interfaces is not a reason to expose legacy factories to new tool authors.

## Retained ProgramDriver and remote adapters

The local, AgentCore and Cloudflare packages also retain ProgramDriver/session
paths. `RetainedPreparedToolExecution` can contain resource factories, bindings,
drivers and driver factories. `routeTools` still combines these alongside portable
Guest acquisition; that compatibility assembly has not been deleted.

Flowmode's backend is another explicit adapter: it maps kernel exchanges to host
operation descriptors and correlated program boundaries. The kernel advances
compute; the host interprets operations and owns durable acceptance.

The old remote deployment apps were removed to stop constraining the rewrite.
Framework adapter tests remain. Passing those tests demonstrates the exercised
runtime contract, not a working deployment of the current yo-chat host to every
remote target.

## Rules that survive translation

1. Preserve request/reply correlation. Keyed author declarations retain concrete
   reply types; dynamic registries validate the selected operation at runtime.
2. Preserve raw acceptance and transformation ownership. Transport/admission may
   validate a reply without replacing the raw value later replayed at the author
   boundary. Do not feed transformed output back through an input schema.
3. Distinguish authored failure, transport loss and uncertain dispatch. Their
   recovery policies differ.
4. Keep logical cancellation separate from close/disposal. Cleanup can yield more
   requests; abandoning transport must not masquerade as accepted cancellation.
5. Do not use one identifier for commands, model calls, suspension correlation,
   journal positions and worker generations.

Sources: [worker client](../packages/tool-runtime-local/src/worker-guest.ts),
[worker server](../packages/tool-runtime-local/src/guest-worker.ts),
[MCP bridge](../packages/tool-session/src/mcp/bridge-runtime.ts),
[MCP handler](../packages/tool-session/src/mcp/handler/mcp-handler.ts),
[retained placement](../packages/tool-session/src/execution/placement.ts).
Evidence: [worker exchanges](../acceptance/__tests__/tool-runtimes/local-worker/exchange.acceptance.test.tsx),
[MCP continuations](../acceptance/__tests__/protocols/mcp/continuations.acceptance.test.ts),
[Cloudflare executor](../acceptance/__tests__/tool-runtimes/cloudflare/executor.acceptance.test.ts).
