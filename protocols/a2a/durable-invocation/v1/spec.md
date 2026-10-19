# Durable Invocation Extension v1

**Status:** Experimental v1 — published extension contract

**Extension URI:** `https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/durable-invocation/v1/spec.md`

## 1. Purpose

This A2A extension closes initial and continuation-message dispatch ambiguity without changing A2A task authority. The A2A server remains the sole authority for its tasks. The extension adds:

- caller-generated opaque invocation identity;
- expiring create requests;
- idempotent stable-message processing;
- linearizable invocation reconciliation; and
- linearizable cancellation-before-binding fencing.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are interpreted as defined by RFC 2119 and RFC 8174.

## 2. Advertisement and activation

An implementation advertises the exact Extension URI in `AgentCapabilities.extensions`. Its closed `params` object is:

```ts
interface DurableInvocationExtensionParamsV1 {
  protocolVersion: 1;
  resolveEndpoint: string; // authenticated same-origin HTTPS by default
  abortEndpoint: string; // authenticated same-origin HTTPS by default
  messageIdempotency: true;
  retention: {
    invocationBindingSeconds: number;
    abortTombstoneSeconds: number;
    messageIdempotencySeconds: number;
    taskSeconds: number;
    terminalResultSeconds: number;
    clockSkewSeconds: number;
  };
}
```

All retention values are integer seconds. Every value except `clockSkewSeconds` MUST be positive; clock skew MAY be zero.

Clients MUST activate the exact URI through `A2A-Extensions`. Every extension response MUST echo the activated URI. A missing or mismatched echo MUST fail closed. Protected Agent Card, send, resolve, abort, task, subscription, continuation, and cancellation operations MUST enforce one consistent principal/tenant authorization policy.

## 3. Identity and initial dispatch

For an initial `SendMessage`, extension metadata has this closed shape:

```ts
interface DurableInvocationMetadataV1 {
  protocolVersion: 1;
  invocationId: string;
  messageId: string;
  messageDigest: string; // lowercase SHA-256 of canonical Message content
  requestExpiresAt: string; // ISO-8601 instant
}
```

The invocation ID and message ID are opaque correlation identities, not credentials. They MUST NOT expose raw journal, session, task, pull, tenant, or credential structure.

Before accepting a create request, the server MUST:

1. authenticate and authorize the caller and tenant;
2. reject an expired `requestExpiresAt`;
3. validate the canonical message digest;
4. bind the invocation ID to the principal, tenant, selected agent, and digest; and
5. check for an active abort tombstone.

Reuse of one invocation or message ID with different canonical content MUST return `idempotency_conflict`. Exact duplicates MUST return the same bound `Task` or terminal direct `Message` while retention remains active.

Initial durable-adapter sends SHOULD set non-blocking/return-immediately behavior. Task completion is observed separately.

## 4. ResolveInvocation

`ResolveInvocation` is an authenticated `POST` to `resolveEndpoint` with:

```ts
interface ResolveInvocationRequestV1 {
  invocationId: string;
  messageDigest: string;
  requestExpiresAt: string;
}
```

The response is exactly one of:

```ts
type ResolveInvocationResponseV1 =
  | { status: "not_found" }
  | { status: "bound"; result: A2ATaskOrDirectMessage }
  | { status: "aborted"; expiresAt: string };
```

Resolve MUST be linearizable with creation. A committed invocation MUST return the same bound object for every authorized lookup during retention. `not_found` describes only the operation's linearization point and MUST NOT be represented as a future-create fence.

## 5. AbortInvocation

`AbortInvocation` is an authenticated `POST` to `abortEndpoint` with the same request shape as resolve. Its response is:

```ts
type AbortInvocationResponseV1 =
  | { status: "bound"; result: A2ATaskOrDirectMessage }
  | { status: "aborted"; expiresAt: string };
```

Abort MUST atomically return an existing binding or install an idempotent abort tombstone. It MUST NOT return bare `not_found`.

If creation linearizes before abort, abort returns the binding. If abort linearizes first, every delayed or retried create for that invocation MUST be rejected as aborted. The tombstone MUST remain through the request expiration plus advertised clock skew and MUST also satisfy `abortTombstoneSeconds`.

Only an active abort tombstone permits a caller to claim `definitely_not_created`.

## 6. Continuation-message idempotency

The extension MUST apply stable-message idempotency to messages sent to existing interrupted tasks. The identity is scoped to authenticated principal, tenant, invocation ID, task ID, and message ID.

An exact duplicate within `messageIdempotencySeconds` MUST execute once and return the same response. Conflicting content under one message ID MUST return `idempotency_conflict`. A client MUST evaluate the effective message-idempotency expiration immediately before every state-changing send.

A server MAY renew invocation-binding and message-idempotency retention while a bound task is nonterminal. Every renewal MUST return explicit updated expiration values; callers MUST durably record a renewal before relying on it.

## 7. Retention and expiry

The server MUST NOT claim a guarantee beyond its advertised effective expiration.

- Expired invocation binding makes unresolved creation uncertainty indeterminate.
- Expired message idempotency prevents another state-changing message unless the caller explicitly negotiates a new policy or accepted renewal.
- Expired task/result retention returns a typed unavailable/not-found result and MUST NOT trigger automatic task recreation.
- A still-readable bound task MAY continue to be observed after invocation/message-idempotency expiration.

## 8. Error codes

Extension errors use bounded safe text and one of:

```ts
type DurableInvocationErrorCodeV1 =
  | "authentication_failed"
  | "authorization_denied"
  | "extension_not_activated"
  | "protocol_version_unsupported"
  | "request_expired"
  | "invocation_aborted"
  | "invocation_not_found"
  | "idempotency_conflict"
  | "payload_too_large"
  | "retention_expired"
  | "protocol_error";
```

Errors MUST NOT contain credentials, unrestricted message content, internal stack traces, or private routing data.

## 9. Security considerations

- Every payload is untrusted and MUST be bounded and schema validated.
- Extension endpoints MUST use HTTPS except explicit loopback tests.
- Redirect, DNS, origin, and private-network policy MUST be revalidated before credentials or payloads are sent.
- Invocation and message identities are not authorization tokens.
- Reconciliation MUST be scoped to the authenticated caller and tenant; cross-caller lookup MUST fail without confirming hidden invocation existence.
- The server remains authoritative for task execution, artifacts, tools, sampling, cancellation, retention, and terminal state.

## 10. Compatibility

Version 1 is identified by the exact URI and `protocolVersion: 1`. Unknown fields in v1 extension objects are rejected. Breaking identity, state-machine, retention, or retry changes require a new extension URI. Published v1 semantics are immutable except for compatible clarification.
