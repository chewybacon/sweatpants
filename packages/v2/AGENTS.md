# V2 engineering conventions

## Testing

The primary testing method is protocol-simulated, in-process acceptance testing.
Do not add or run unit tests for v2. Put acceptance journeys under
`acceptance/__tests__/*.acceptance.test.ts` and reusable test rigs, protocol
simulators and fixtures in `testing` (`@sweatpan.ts/testing`).

Exercise public APIs with real framework composition. Simulate external protocol
peers rather than mocking internal functions. Tests must be deterministic and own
resource cleanup. Do not require live providers, external services, deployment or
subprocess test rigs. State the limits of simulated recovery evidence honestly.
Production packages must not depend on acceptance or testing packages.

Run `pnpm v2:land` for v2 changes; `pnpm land` currently aliases this focused
gate. Run `pnpm v2:test` for acceptance journeys. An empty scaffold is not passing
behavioral coverage. The legacy suite remains available separately; its existing
tests do not establish v2 coverage.

## Organization

Follow README.md for package names, exports and file responsibilities.
Keep contracts public, shared implementation types internal and entry points
explicit. Port behavior and its acceptance evidence together.

## Stream-first authoring

Stream-first is the default for operations that produce progress or a sequence of
values followed by a result. Expose the stream as the primary implementation; layer
callback conveniences and collect/drain runners on it. Maintain one producer, not
parallel callback and stream implementations. Single-result operations remain plain
operations; do not invent progress to force them into a stream.

Use the existing Stream/Subscription contracts. Pull-driven sources advance on
next(); signals/channels broadcast independently. Choose deliberately and document
ownership, repeated subscription, early exit, failure and terminal result behavior.
Use createPullStream for a single-owner pull source and createStreamApi when scoped
subscription policy is needed. Neither records events or creates a producer task.
Guest streams must forward domain/logical instructions, never native Host operations.
Keep external reader lifetimes independent of application-owned production.

See runtime/README.md for authoring and chat/README.md for the Guest example. Prove
new lifecycle semantics with public acceptance journeys, including cancellation.
