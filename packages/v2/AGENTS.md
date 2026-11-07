# V2 engineering conventions

## Assembly-driven API design

Read [FOOTGUNS.md](./FOOTGUNS.md) when designing or promoting a capability. Record
newly discovered complexity traps there with the supported boundary and author
responsibility; do not turn every unsupported edge case into framework scope.

The current work is capability assembly: discovering the APIs and compositions that
make concrete applications straightforward to build from the existing foundation.
Do not assume every missing feature requires a new primitive, or that every useful
assembly should become a framework API. A new primitive is justified when a concrete
assembly exposes a missing fundamental guarantee that existing mechanisms cannot supply.

Use this lexicon in proposals, reviews and handoffs:

- **Primitive:** a mechanism establishing a fundamental guarantee, such as scope
  ownership, atomic acceptance or replay.
- **Capability:** a consumer-facing operation or set of operations, such as sampling,
  admission or program resolution. An API facade alone grants no authority.
- **Policy:** a choice about how a capability behaves, such as model selection, round
  limits or retention. Scoped middleware is appropriate when that choice decorates
  an existing operation; core correctness remains in the owning implementation.
- **Assembly:** concrete wiring of capabilities, policies and lifetimes for a use case.
  It identifies who owns work, which instances consumers invoke and how resources end.
- **Adapter:** an implementation connecting a capability or assembly to a provider,
  transport, storage engine, runtime or platform.
- **Assembly experiment:** a provisional consumer used to discover requirements and
  evaluate boundaries. Its local APIs and policies are not presumed framework exports.

Work from a concrete consumer toward a reusable boundary:

1. State the application behavior to unlock and the existing capabilities it can use.
   Consult prior research and current code; distinguish missing behavior from missing
   wiring, a deliberate omission, or an outdated gap description.
2. Assemble the behavior with existing public APIs in an acceptance journey. Keep
   provisional contracts and application-specific policy local. Reuse a relevant
   journey where possible rather than building a parallel lifecycle test suite.
3. Identify repeated wiring, awkward boundaries or a missing guarantee. Name which
   category above needs to change. Prefer ordinary composition or a pure helper when
   those suffice; do not add a scoped API just to wrap a function or fill a scaffold.
4. Extract only the boundary supported by the consumer evidence. Explain who uses it,
   what it owns, which guarantees it adds and which choices remain with assembly.
   Repeated use is useful evidence, not a mandatory quota of consumers. One concrete
   consumer can justify a boundary when its semantics and benefit are clear.
5. Route the actual consumer through the extracted implementation and retain its
   behavioral and inference evidence. Remove superseded experimental paths. Document
   remaining limits without claiming transport, browser, persistence or deployment
   guarantees that the experiment did not establish.

Promotion is a design decision, not an automatic consequence of a passing spike.
Acceptance proves the exercised behavior, not that the API shape is right for every
consumer. Keep uncertain designs experimental; preserve explicitly parked or unstaged
work until the user chooses to revisit it. A scaffolding file records a place for a
responsibility, not an obligation to invent an implementation.

## Recognize composition opportunities

Read [Runtime composition guidance](./runtime/COMPOSITION.md) before introducing a
policy callback, replaceable driver, interception hook, or new middleware surface.
Look beyond asynchronous operations: regular functions, acquired handles, stream
subscriptions and configuration can also participate in composition. Do not reject
middleware merely because the consumer is synchronous.

Choose and state when behavior is selected: construction, acquisition, or each call.
Then choose existing direct decoration, scoped API dispatch, or context lookup.
Keep resource ownership explicit. Prefer existing composition over bespoke hook
registries, but do not make every private helper a scoped API. When the requested
semantics are not supported, describe the abstraction gap; an assembly workaround
for one consumer does not settle whether the Runtime should support a broader shape.

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

Explicit exception: workflow compiler acceptance may launch the pinned ScriptC/tsgo
subprocess through the public build API. Exercise fresh compilation and cached
artifacts using test-owned temporary directories; the adapter must dispose compiler
sessions and scratch files on success and failure. Do not install dependencies or
require live providers inside tests. This exception does not permit general subprocess
application rigs.

Run `pnpm v2:land` for v2 changes; `pnpm land` currently aliases this focused
gate. Run `pnpm v2:test` for acceptance journeys. An empty scaffold is not passing
behavioral coverage. The legacy suite remains available separately; its existing
tests do not establish v2 coverage.

## Organization

Follow README.md for package names, exports and file responsibilities.
Keep contracts public, shared implementation types internal and entry points
explicit. Port behavior and its acceptance evidence together.
Every package retains contracts.ts, apis.ts, middleware.ts and types.ts scaffolds.
Reusable scoped policies belong in middleware.ts; application-specific policy stays
with its application. Required assembly middleware must be explicitly installed and
documented; core correctness must not depend on remembering an optional installer.

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
