# `@sweatpants/a2a`

Caller-authoritative remote structured children for Sweatpants.

This package discovers an exact pinned Sweatpants program through an A2A Agent Card extension and projects the existing `ProgramDriver` contract over authenticated HTTPS/WSS. It does **not** create a callee-owned A2A Task. The caller journal remains the sole authority for child allocation, ordered operations, effects, emissions, cancellation, replay, and terminal outcomes.

## Security boundary

- Agent Card and manifest URLs are untrusted SSRF inputs. The default Node clients require TLS, enforce same-origin endpoints, revalidate bounded redirects and DNS answers, and reject private/reserved networks unless explicitly allowlisted.
- Authentication headers are supplied at request time and are never part of durable routes, execution IDs, protocol envelopes, or logs.
- The executor receives proposals and recorded outcomes only. Journal credentials, resolution capabilities, model-provider credentials, caller effect credentials, and private routes do not cross the wire.
- Every child effect, including `model.sample`, is resolved by caller-installed handlers under the caller authority.
- **Returning an effect result discloses that result to the remote child.** Caller-side routing provides credential custody, policy mediation, approval, and audit; it does not control the child's later use of intentionally disclosed result data.
- Default observation events contain opaque IDs and digests, not full parent context or unrestricted effect payloads.

## Placement

Create a route with `createA2AProgramRoute`, build the driver's manifest callback with `createPreflightedRemoteManifestProvider`, register `createA2AProgramDriver` under driver kind `"a2a"`, and let `ProgramRouteResolverContext` select that route only for the exact advertised child identity. The preflighted provider verifies every caller handler before child allocation. Nested children and effects remain subject to caller deployment policy.

The v1 profile supports joined `invoke` only. It exposes no remote detach or spawn API.

Cancellation is a one-shot authority command. Retries MUST retain the first cancel reason; changing the reason under the same attachment intentionally produces `idempotency_conflict`. After transport loss, callers create a fresh attachment and recover through journal replay—they do not carry attachment-scoped command IDs to the new connection.

The reference executor retains all accepted command responses for the attachment lifetime as required by the protocol. Deployments bound memory with configurable active-attachment and commands-per-attachment limits, plus bounded epoch-fencing tombstones; they do not evict live command records with an LRU.

## Foreign A2A tasks

Opaque A2A agents use the separate `foreignA2ATaskAdapter`; they do not use caller-authoritative program execution. The foreign server remains authoritative for its task, sampling, tools, artifacts, retention, cancellation, and terminal state.

`discoverForeignA2AAgent` defaults to the published durable-invocation extension and fails before dispatch when reconciled mode is unavailable. Weaker `idempotent_messages`, `task_handle_only`, and `best_effort` modes require explicit configuration. `ForeignA2ADurableSession` exposes binding-neutral start, observe, respond, cancel, and await-result operations. `createHttpJsonForeignA2AClient` supplies the HTTP+JSON binding, and `createSecureForeignA2AHttpTransport` applies the shared TLS, SSRF, redirect, origin, authentication, and DNS-pinning policy to every remote operation.

The adapter uses its own pinned program and effects. It does not modify `sweatpants.foreign-tool-adapter@1.0.0`. Input-required and auth-required are distinct typed interruptions; application policy decides whether to answer, elicit, observe out-of-band authorization, cancel, or abandon. Credentials are never placed into generic A2A message parts by the adapter.

## Callee-authoritative Sweatpants peers

`discoverSweatpantsPeer` requires reconciled durable invocation plus the exact Sweatpants peer and delegated-effects v1 extensions. It retrieves an exact skill requirement manifest, preflights caller-routed handlers and validators, builds a canonical invocation-scoped offer, and pins the negotiated grant-set digest. `callPeerAgent` deliberately compiles to the foreign A2A obligation rather than caller-authoritative `invoke`.

`compilePeerResolverBundle` generates a replay-pinned local program containing exactly one granted effect contract. `InMemoryDelegatedEffectsService` is the callee-side reference event/outbox protocol, while `PeerDelegatedEffectCoordinator` maintains independent caller observation and effect-execution frontiers. Later control events can therefore cancel a parked active effect without authorizing later effect requests out of order.

The caller and callee retain separate journals and credentials. Grants are authenticated invocation-scoped references, not bearer credentials. Effect result delivery is disclosure to the callee, and cross-journal idempotent acceptance does not turn an unreconcilable external effect into a globally exactly-once transaction.

## Assembled test-rig acceptance

Package-local tests certify caller-authoritative drivers, foreign tasks, real HTTP/WSS bindings, independent-process recovery, and three-process peer delegated effects. `createControllableForeignA2AAgent()` from `@sweatpants/a2a/testing` provides buffered causal controls for initial dispatch, continuation, observation, and cancellation; package tests use it to drive `input_required` through terminal completion without pre-armed promise choreography. The higher-level assembled scenarios live in the private `@sweatpants/framework-acceptance` leaf to avoid an `a2a → test-rig → framework → a2a` dependency cycle:

- `a2a-agent.acceptance.test.ts`: The harness discovers and drives the same standard agent through an assembled code handle and an independently hosted real-HTTP origin, while causally controlling its pi-ai model request.
- `a2a-subagent.acceptance.test.ts`: The same authored crank-native child runs as a mounted packaged handle and through a real A2A WebSocket driver/executor; both preserve nested sampling, durable elicitation, replay, and final outer response.

Together these layers keep protocol ownership in this package while the leaf certifies the assembled product path.

## Third-party interoperability gate

The deterministic suite uses project-owned protocol fixtures. Before a pre-1.0 release, run the opt-in conformance smoke test against at least one independent A2A 1.x server:

```sh
A2A_INTEROP_CARD_URL=https://agent.example/.well-known/agent-card.json \
A2A_INTEROP_SKILL_ID=skill-id \
pnpm -C packages/a2a test:interop
```

Optional variables are `A2A_INTEROP_BEARER_TOKEN`, `A2A_INTEROP_PROMPT`, `A2A_INTEROP_MINIMUM_GUARANTEE`, and `A2A_INTEROP_DERIVATION_KEY`. The gate uses `task_handle_only` by default and validates the real card, binding, task/message shapes, and normalized result. It is skipped in hermetic CI when no external endpoint is configured.
