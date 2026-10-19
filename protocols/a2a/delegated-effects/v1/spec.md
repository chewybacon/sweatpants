# Delegated Effects Extension v1

**Status:** Experimental v1 — protocol certified; exhaustive journal fault matrix required before 1.0

**Extension URI:** `https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/delegated-effects/v1/spec.md`

## Purpose

This extension lets a callee-authoritative Sweatpants A2A task request exact, invocation-granted effects from its authenticated caller without transferring caller credentials or journal authority. Each peer keeps an independent journal and durable outbox.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** follow RFC 2119 and RFC 8174.

## Activation and authority

The exact URI MUST be advertised and activated through `A2A-Extensions`; extension responses MUST echo it. Every operation MUST authenticate and authorize the same peer task, caller principal, tenant, durable invocation, and immutable grant chain.

The callee journal is authoritative for effect requests, cancellation requests, amendments accepted by the task, and local pull resolution. The caller journal is authoritative for local resolver execution, revocation enforcement, and response delivery. Neither side accepts the other's journal entries or capabilities.

## Required operations

A binding MUST provide operations equivalent to:

```ts
ListDelegatedEffectEvents(taskId, afterCursor, pageSize?)
GetDelegatedEffectStatus(taskId, effectId)
ResolveDelegatedEffect(taskId, effectId, responseId, outcome)
ApplyGrantAmendment(taskId, amendmentId, amendment)
RevokeGrant(taskId, revocationId, grantId)
```

HTTP bindings MAY expose these beneath the profile's authenticated `delegatedEffectsEndpoint`. Streaming MAY wake clients, but polling `ListDelegatedEffectEvents` is the recovery baseline.

## Event log

The callee MUST append an event before exposing it. The closed event types are:

- `effect_requested`
- `effect_cancel_requested`
- `grant_amendment_requested`
- `retention_renewed`
- `task_terminal`

Every event binds a stable opaque event ID, monotonic cursor, task and invocation IDs, and canonical event digest. Effect requests additionally bind effect ID, exact grant/version, whole-contract digest, canonical input/digest, route, and cancellation state.

`ListDelegatedEffectEvents` MUST return a gap-free range strictly after `afterCursor`, a stable high-watermark, earliest retained cursor, expiration, and canonical page digest. Missing, skipped, expired, duplicate-conflicting, or divergent events MUST fail closed.

The caller MUST retain separate observation and execution frontiers. Observation MAY advance through later cancellation, amendment, retention, and terminal control events while an earlier effect execution remains parked. Effect requests execute sequentially by cursor in v1.

## Effect responses

Before local execution the caller MUST verify peer identity, task/invocation binding, grant/version, route, contract digest, input digest/schema, policy constraints, budget, expiry, revocation, and cancellation state.

A response binds:

```ts
interface DelegatedEffectResponseV1 {
  taskId: string;
  effectId: string;
  responseId: string;
  grantId: string;
  grantVersion: number;
  contractDigest: string;
  outcome: OperationOutcome;
  outcomeDigest: string;
  eventCursor: number;
}
```

The caller MUST record the resolver outcome and response outbox before delivery. Exact duplicate responses MUST return the original acknowledgment; changed content under one response ID MUST return `idempotency_conflict`. Lost acknowledgment is reconciled by resending the same response or querying effect status, never by rerunning the resolver.

The callee MUST validate authentication, grant/version, effect identity, output/error/cancellation-partial schema, outcome digest, and task state before resolving its local pull exactly once.

## Exact contracts and grants

Each contract canonically covers symbolic name, version, input/output schema descriptors and digests, optional cancellation-partial descriptor, retry safety, and whole-contract digest. Name/version alone is insufficient.

A grant is an invocation-scoped reference, not a bearer credential. It binds caller/callee identities, invocation/task, exact contract, route, constraints, budget, expiry, delegation rule, grant ID, and immutable version. Caller credentials MUST NOT appear in grants or events.

Grant sets use canonical JSON. Contracts are sorted by effect name, version, then contract digest; absent optional fields are omitted. Grant-set SHA-256 uses domain `sweatpants.peer.grant-set.v1`.

Amendments form an append-only hash-linked chain and never alter existing effect requests. Revocation takes effect at the caller before network delivery and does not erase committed effects. Transitive delegation is forbidden unless explicitly attenuated by agents, contracts, budget, expiry, finite depth, and cycle policy.

## Cancellation

Callee unwind MUST append `effect_cancel_requested` without erasing the original request. The caller MUST observe controls beyond a blocked execution frontier, avoid starting already-canceled work, and signal live handlers where possible. Actual completed, canceled/partial, not-cancelable, or indeterminate outcomes are returned; cancellation success MUST NOT be fabricated.

## Bounds and retention

Canonical inline inputs, outcomes, partials, amendments, and controls MUST be at most 1 MiB. Protocol pages MUST be at most 2 MiB. Values are never truncated.

Events, grants, responses, cancellation evidence, and acknowledgments MUST remain available through terminal-result retention. Expiry returns `peer_protocol_expired` or `remote_state_expired` and MUST NOT recreate work.

## Security and disclosure

Effect inputs and outcomes are untrusted and independently schema validated by both authorities. Returning an outcome discloses it to the callee. This extension provides credential custody, policy mediation, execution, and audit—not control over the callee's later use of disclosed data and not a global exactly-once claim for unreconcilable external services.

Breaking changes require a new extension URI. Published v1 semantics are immutable except for compatible clarification.
