# ADR-002: Token UX Is Nonsemantic and Uses the Existing Durable Streams Path

**Status:** Accepted

## Context

Model providers produce high-volume deltas primarily to reduce perceived latency. Programs and the semantic journal need only the completed `model.sample` outcome. Sweatpants already has a ref-counted `TokenBuffer`/Durable Streams path that eagerly consumes one source, lets UI readers pull by LSN, continues after an HTTP reader disconnects, and can use in-memory, shared-memory, or Redis storage.

A later change added an activation-local `ActivityStreamStore`, wrote every model delta to it, never read it, then copied the same delta through a queue into the existing TokenBuffer. This duplicated concepts without improving reconnect behavior.

## Decision

Model streaming has three roles:

```text
model provider stream
  -> ref-counted TokenBuffer / response stream for transient UX
  -> optional durable-stream backing for retained cursor reads

model.sample completed result
  -> semantic journal outcome
```

The `model.sample` handler, while being pulled by `ProgramRuntime.run()`, eagerly pulls the provider to completion. It appends transient public deltas directly to the Host-owned response TokenBuffer and accumulates one canonical final response. The authority journals only that final effect outcome.

The TokenBuffer is the active/ref-counted facade. Its configured store may also provide the retained activity-log role. A Redis-backed TokenBuffer can therefore be both the live handle and durable reconnect log without introducing a second physical store.

An implementation MAY later separate an ephemeral coalescing buffer from a durable activity backend, but it MUST preserve one write path. It MUST NOT mirror through an autonomous queue or instantiate an unread per-engine activity store.

## Pull and eager boundaries

- The one session source writer is allowed to pull the crank-backed source eagerly.
- `ProgramRuntime.run()` is the sole consumer of ProgramDriver steps.
- The live model handler pulls provider chunks inside that crank turn.
- HTTP and UI readers pull the TokenBuffer/Durable Stream by LSN.
- `waitForChange(afterLSN)` is a reader continuation, not timer polling.

## Recovery guarantees

- Client reconnect during a live model call can resume from the retained TokenBuffer LSN.
- Client disconnect does not cancel the model call or crank.
- Process loss may discard transient token deltas when no durable backing is configured.
- Process loss does not lose a completed semantic model result already accepted by the journal.
- Token deltas are never replay inputs.

## Required delivery properties

The real TokenBuffer/Durable Streams composition owns:

- one stable response-stream ID;
- ordered LSNs;
- non-destructive reads after an LSN;
- one source writer per session;
- explicit complete/error state;
- reference-counted readers;
- configured retention and cleanup;
- blocking wait without timer polling.

Activation authority and the session registry fence the single writer. If multi-writer storage is later introduced, fencing and idempotent duplicate acceptance MUST be added to this real path rather than to a parallel store.

## Consequences

- Live tokens improve UX without inflating the journal.
- Child and sub-agent samples can share the root Host’s token projection when configured.
- Hosts without a token UI can omit live projection and retain only the completed result.
- Terminal output or other nonsemantic activity may reuse the same Durable Streams backend, but must not create another engine-local queue.

## Enforcement

Tests cover incremental delivery, disconnect/reconnect by LSN, continued production with zero readers, one final journal outcome, absence of token chunks from the journal, ref-count cleanup, and the single source-writer boundary.
