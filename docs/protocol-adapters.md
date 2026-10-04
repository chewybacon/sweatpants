# Protocol adapter boundaries

Sweatpants uses protocols at its edges. The execution journal remains authoritative;
Effection owns activation lifetime and pull-based delivery.

## Durable Streams

`TokenBuffer.read(afterLSN, limit?)` supports bounded suffix reads. Its returned `lsn`
is still the stream tail. The Effection pull subscription consumes a batch at a
time without starting a background reader. Redis seeks by token LSN rather than
materializing stream history. See `packages/durable-streams/README.md` for the
response-buffer format and reset policy.

This is a token-delivery adapter, not a claim of full upstream byte-stream protocol
conformance. Delivery offsets do not determine execution progress.

## AG-UI 1.0

All workspace consumers use `@ag-ui/core@1.0.1`. Runtime schemas come from
`@ag-ui/core/schemas`; event types come from the main entry. Native run-start events
declare protocol version `1.0`.

The boundary supports ordered multimodal tool-result parts and defaults an omitted
text-message role to assistant. Activity normalization preserves attribution and
other validated envelope fields. File-handle content cannot be translated into
canonical chat content until an explicit file resolver exists; conversion fails
instead of inventing a URL or dropping the part.

Native conversation streams still require Sweatpants authority and window ordering.
They are not a generic tolerant AG-UI transport. Public child executions now carry
stable, opaque `subagentRunId` attribution on their projected events and pending
interrupts. Message attribution survives UI projection and hydration. The native
validator checks message/tool/activity ownership, step ownership, and announced
subagent lifecycle ordering, including ownership restored from window snapshots.
Native producers use attribution-only streams; they do not yet emit subagent
lifecycle announcements. Usage decoding does not imply usage accounting.

## MCP 2026-07-28

The public MCP endpoint implements only `2026-07-28`. Inspector is pinned to
`2.9.0`, and yo-mcp launches it with `--protocol-era modern`. The migration removes
initialize, protocol sessions, GET/DELETE transport routes, and Last-Event-ID
resumption. Unsupported RPC methods fail explicitly; optional subscriptions,
resources, prompts, roots and URL elicitation are not advertised.

Application authors configure tools and execution once. The app owns lazy setup,
Effection scopes, invocation resources and request cleanup:

```ts
import { createMcpApp } from "@sweatpants/agent-host/mcp";
import { local } from "@sweatpants/tool-runtime-local";

const app = createMcpApp({
  name: "my-tools",
  version: "0.1.0",
  secret,
  tools: [pickCard, greet],
  execution: local({ worker: new URL("./tool-worker.mjs", import.meta.url) }),
  *authenticate(request) {
    return yield* authenticateCaller(request);
  },
  setup: {
    application: installApplicationServices,
  },
});

// Mount in an existing Fetch-based framework:
export const POST = app.handler;
// The owning framework calls app.close() during teardown.
```

`setup` is optional. It runs once before the first request; authentication inherits
its scoped services. `authenticate` returns a trusted, stable caller ID to bind
continuations, never self-reported MCP clientInfo. Origins default to same-origin;
additional trusted origins can be listed in `allowedOrigins`. Authored `createTool`
definitions and the execution host contract are unchanged. `execution` uses the
same placement interface as chat, without importing any concrete runtime into
Agent Host. This factory requires invocation resources; it does not install a
journal host for crank-native durable programs.

For standalone Node hosting:

```ts
import { serve } from "@sweatpants/agent-host/node";

const server = await serve(app, { hostname: "127.0.0.1", port: 3001 });
// During shutdown: stops ingress, cancels connections, awaits app cleanup.
await server.close();
```

`serve` uses srvx 1.0.5's Node adapter and leaves process signal handling to the
entry point. It accepts optional srvx middleware for application HTTP policy,
such as the local Inspector demo's CORS headers. Applications do not convert or
pipe Readables. The transport stops pulling when socket writes need `drain` and
cancels the Web reader on disconnect. MCP response streams keep a zero high-water
mark; the socket has bounded transport buffering, not an eager response collector.
The Node adapter is covered by a blocked-writable test and real socket disconnect
tests, alongside MCP's one-notification-per-demand test.

Advanced hosts can mount `toNodeHandler(app.handler)` on an existing `node:http`
server, retaining responsibility for `app.close()`. Scope-owning Effection hosts
can use `createMcpHandler` from `@sweatpants/tool-session/mcp` after installing an
invocation runtime; it uses the same `authenticate` option. Request-level errors
are isolated from the application supervisor, while app shutdown cancels request
scopes and runtime resources.

Each POST carries version, method and optional target headers, plus request-local
client capabilities. Annotated tool parameter headers are compiled and checked.
Discovery and tool lists include cache policy; tool calls return request-scoped SSE
notifications followed by one `complete` or `input_required` result. Log messages
require an explicit request log level. The Web stream pulls projection records on
demand; the Node demo propagates socket backpressure and cancellation.

### Continuations and authored interactions

Elicitation and sampling use `inputRequests` embedded in `input_required`. The
client retries the original method and arguments with a new JSON-RPC ID,
`inputResponses`, and the signed `requestState`. Tokens bind the server, authenticated
caller, method, arguments, invocation, pending cursor and expiry. Each retry checks
current capabilities. The invocation host deduplicates the resume command and
rejects changed answers. Independent initial calls get independent invocation IDs;
JSON-RPC IDs are not an initial-call idempotency key.

Plain flat form schemas work directly. A rich authored interaction can install a
MCP-only projection without changing its tool contract:

```ts
forms: {
  pick_card: {
    choose: {
      present(ask) {
        return {
          message: ask.message,
          requestedSchema: {
            type: "object",
            properties: { rank: { type: "string", enum: ["A", "K"] } },
            required: ["rank"],
          },
        };
      },
      accept(content) {
        return { card: { rank: content.rank } };
      },
    },
  },
}
```

The runtime still validates the mapped authored response. Decline and cancel pass
through unchanged. Sampling preserves tool-use responses for agent-like tools.

Transport tokens are signed references, not execution state or authority. Durable
restart guarantees remain those of the installed runtime. The yo-mcp demo uses a
live worker runtime; this endpoint does not turn it into a durable journal. The
separate `apps/yo-chat/acceptance/mcp-pick-card-tracer.test.ts` proves continuation
reconstruction and deduplication against the durable journal, including nested
card projection. It is a test fixture, not a second production endpoint.

`createMcpContinuations` remains available for adapters integrating directly with
a journal. It supports verification-key rotation and a configurable TTL;
`decodeMcpFormResponse` validates exactly the pending response key and flat content.
