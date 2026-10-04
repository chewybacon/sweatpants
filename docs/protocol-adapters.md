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

## MCP multi-round-trip tracer

The production MCP endpoint still implements `2025-11-25`. The executable
`apps/yo-chat/acceptance/mcp-pick-card-tracer.test.ts` explores the `2026-07-28`
`input_required` / retry exchange against the real authored `pick_card` program.
The adapter is a test fixture, not a second exported MCP server.

The tracer opens one durable invocation, projects a journaled elicitation into
`inputRequests`, and issues a signed `requestState` bound to the caller, invocation,
method, tool, arguments, pending pull, and expiry. A retry has a new JSON-RPC ID but
resolves the same journaled pull. Duplicate accepted content returns the existing
terminal result; conflicting content is rejected. Reconstructing the authority
from a serialized snapshot and creating a fresh generator driver does not redraw
cards. Tampered, expired, or incorrectly bound continuations cannot resolve input.

The tracer translates a standard flat MCP form selection back into the authored
nested card response before journal validation. Acceptance, decline, and cancel
all survive authority reconstruction and duplicate retries without another draw.

### Reusable continuation API

`@sweatpants/tool-session/mcp` exports `createMcpContinuations` and
`decodeMcpFormResponse`. Both token operations are Effection operations:

```ts
const continuations = createMcpContinuations({
  secret,
  verificationSecrets: [previousSecret], // optional rotation window
  ttlMs: 300_000,
});
const binding = {
  serverId: "my-mcp-server",
  callerId: authenticatedCallerId,
  method: "tools/call",
  params: { name, arguments: args },
};
const requestState = yield* continuations.issue(binding, { invocationId, pullId });
const reference = yield* continuations.verify(requestState, binding);
const response = decodeMcpFormResponse(inputResponses, reference.pullId);
```

Bindings exclude JSON-RPC IDs and continuation fields. Caller identity must come
from authentication, not client-provided form data. Tokens use HMAC-SHA256, a
request-binding digest, expiry, bounded parsing, and optional verification keys
for rotation. They are signed, not encrypted; they contain journal references,
never journal capabilities or generator state. Verification does not consume a
token or authorize a response. The adapter must locate the invocation, validate
the authored input, and resolve it through the journal, which owns deduplication.
The form decoder requires exactly the pending response key and flat MCP content;
it does not replace authored schema validation or implement URL-mode elicitation.

Discovery, per-request capabilities, HTTP headers, concurrent request admission,
initial-call retry identity, and the other MCP methods remain separate endpoint
migration work. A protocol version bump alone would incorrectly advertise support.
