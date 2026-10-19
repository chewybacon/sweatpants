# Sweatpants Peer Profile v1

**Status:** Experimental v1 — protocol certified; exhaustive journal fault matrix required before 1.0

**Extension URI:** `https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/sweatpants-peer/v1/spec.md`

## Purpose

This profile identifies a standard callee-owned A2A Task backed by an independent Sweatpants journal and capable of exact invocation-scoped delegated effects. It composes:

- durable invocation v1;
- delegated effects v1; and
- A2A 1.x task, message, observation, and cancellation semantics.

It is distinct from caller-authoritative remote `ProgramDriver` execution and from explicitly degraded opaque foreign A2A invocation.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** follow RFC 2119 and RFC 8174.

## Required extensions

A peer Agent Card MUST advertise and require all exact URIs:

```text
https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/durable-invocation/v1/spec.md
https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/delegated-effects/v1/spec.md
https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/sweatpants-peer/v1/spec.md
```

The peer profile MUST NOT use degraded task-creation guarantees. Missing advertisement, activation, echo, exact contract pinning, event reconciliation, or idempotent response acceptance fails closed before user program execution.

## Profile parameters

The peer extension declaration has this closed `params` shape:

```ts
interface SweatpantsPeerProfileParamsV1 {
  protocolVersion: 1;
  delegatedEffectsVersion: 1;
  requirementManifestEndpoint: string;
  delegatedEffectsEndpoint: string;
  retention: {
    taskSeconds: number;
    invocationBindingSeconds: number;
    effectEventSeconds: number;
    grantSeconds: number;
    effectResponseSeconds: number;
    cancellationEvidenceSeconds: number;
    terminalEvidenceSeconds: number;
  };
  terminalEvidenceKeyId?: string;
}
```

All durations are positive integer seconds. Endpoints are authenticated same-origin HTTPS by default and use the Agent Card principal/tenant policy. Explicit loopback HTTP is permitted only for tests.

## Independent authority

The caller and callee MUST use independent journal authorities and remain sole writers of their journals. The callee owns the standard server-generated A2A task, release, placement, program, effects, artifacts, cancellation, retention, and terminal state. The caller owns a local joined observation/effect-delivery obligation.

Neither side imports snapshots, receipts, credentials, or journal entries from the other. Process or transport loss implies no logical outcome. The peer task MAY continue after caller disconnect or explicit abandonment and is then reported as independent remote work.

## Requirement manifest

Before dispatch the caller retrieves an exact requirement manifest containing:

- skill and callee release identity;
- required/optional effect contracts;
- each contract's exact schemas, cancellation partial, retry safety, and whole-contract digest;
- allowed route policy (`callee`, `caller`, or permitted denial); and
- amendment policy.

One manifest MUST NOT contain multiple versions of one symbolic effect name. Portable descriptors and runtime validators are pinned by digest. Manifest changes do not affect existing tasks except through an explicit amendment.

## Offer and grant

The caller constructs a narrow offer selecting a route for every required effect. Every caller route MUST pass local handler, runtime-validator, whole-contract, and retry-safety preflight. Credentials never appear in an offer.

The callee either returns a typed rejection without starting the skill or atomically binds:

- authenticated caller/callee identities;
- durable invocation and peer task IDs;
- callee journal/release identity;
- requirement-manifest digest; and
- initial grant-set digest.

The initial message carries canonical profile offer data. The created/rejected response MUST echo requirement and grant-set digests. The caller MUST reject omission or mismatch before resolving delegated effects.

## Task projection

A task blocked on a delegated effect or grant decision uses A2A `TASK_STATE_INPUT_REQUIRED`. Its status message MUST state that it awaits delegated-effect or grant resolution and carry the reason/latest event cursor in peer extension metadata. It MUST NOT masquerade as ordinary user input.

When no caller action blocks progress, the task returns to submitted/working. Terminal A2A tasks are immutable; follow-up creates a new task.

## Resolver bundles

Each caller-routed grant compiles to one local pinned resolver program containing exactly one granted effect contract plus fixed adapter schemas/code identity. Its digest is derived from:

```text
SHA-256(domain, baseResolverCodeDigest, exactContractDigest, protocolVersion)
```

A remote effect ID maps deterministically to one local resolver task. Duplicate observations join/replay it. Missing generated code or schemas strand the invocation; newer contracts are never substituted. Resolver tasks obey the exact effect retry safety, including typed indeterminate outcomes.

## Cancellation and abandonment

Caller cancellation records local intent before sending a stable idempotent task cancellation command. The callee applies one-shot durable cancellation, emits cancellations for pending delegated effects, performs cleanup, and returns actual terminal/partial evidence.

The caller distinguishes canceled, already terminal, rejected/not cancelable, expired, and indeterminate. Ambiguous or rejected cancellation means the peer may continue.

Abandonment is a separate explicit durable result. It revokes caller grants locally, ends observation, records the last remote state, and makes no claim that the callee stopped.

## Causal evidence

Both journals record matching opaque invocation, task, grant, event, response, and terminal digests without sharing storage. A callee MAY sign terminal evidence covering task/release/protocol identity, result digest, grant-chain head, delegated-event transcript head, and callee journal root under an Agent Card-verifiable key.

Evidence proves identity and integrity of the disclosed summary—not correctness of private program logic or absence of undisclosed external work.

## Certification scope

The deterministic suite certifies exact grant negotiation, generated resolver execution through a caller journal authority, an independent callee journal-backed task, independent effect-executor credential custody, caller process death after resolver terminal commit, and response-acknowledgment loss/reconciliation.

The profile remains experimental until the exhaustive pre/post-commit fault matrix has killed and replaced caller, callee, and effect-executor processes at every event and response outbox boundary. Published status MUST NOT be represented as proof of every deployment's notification-loss completeness or external-effect exactly-once behavior.

## Bounds, retention, and security

Peer operations use the bounds and retention rules of durable invocation and delegated effects. Retention is renewed while a task remains nonterminal and accepted renewal expirations are journaled before use. Expiry never recreates work.

Credentials, cookies, IAM roles, refresh tokens, browser sessions, private routes, unrestricted effect payloads, and journal capabilities are excluded from default logs and cross-peer grants. Returning an effect result is intentional disclosure to the callee.

Breaking changes require a new profile URI. Published v1 semantics are immutable except for compatible clarification.
