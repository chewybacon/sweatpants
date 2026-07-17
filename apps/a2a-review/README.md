# Caller-Authoritative A2A Review Acceptance

This removable reference application certifies the caller-authoritative A2A vertical without adding consultation semantics to the protocol or session kernel.

## What is certified

- A parent durable program joins `REFERENCE_REVIEWER_TOOL` through `createA2AProgramDriver` and a real caller journal authority.
- `model.sample` and `reference.review.ask_parent` execute only in the caller effect registry.
- Manifest preflight rejects missing handlers and missing runtime validators before remote execution.
- The production WebSocket connector and `bindA2AExecutorWebSocket` binding perform real loopback framing, hello negotiation, attach, duplicate command replay, malformed-frame rejection, oversized-frame rejection, and shutdown.
- The multi-process harness starts caller and executor in independent Node processes. It kills the executor after a computed step and kills fresh caller processes after model-provider commit, user-response commit, and terminal authority commit. Recovery uses a new process and fresh attachment. Persistent pull-ID provider state and authority snapshots prove two model samples, one consultation pull, one user response, and one terminal outcome are accepted.

Run:

```sh
pnpm -C apps/a2a-review test
```

The generated reviewer digest is SHA-256 over the normalized `src/index.ts` source under the `sweatpants.reference-reviewer.artifact.v1` domain. Source changes fail `verify:artifact` until explicitly regenerated:

```sh
pnpm -C apps/a2a-review generate:artifact
```
