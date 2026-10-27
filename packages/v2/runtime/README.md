# Portable runtime

`Runtime<Y>` owns execution, concurrency, resources and Promise integration.
`runtime.composition` supplies scoped APIs, middleware and contexts. Application
modules import these contracts and remain generic in the yielded protocol `Y`.
Only stack assembly selects `runtime-effect` or `runtime-effection`.

`RuntimeType` and `Computation<F, A, E, R>` are structural, type-only mappings from
`@standard-durability/core`, re-exported here. They retain native Effect error and
service slots; Effection tracks its result only. Shared expected failures travel
as explicit Outcome values. The iterator protocol keeps portable workflow bodies
independent of either native implementation.

Both adapters establish fresh composition ownership at start. Child work in all
has isolated bindings; results retain input order and completion awaits cleanup.
A native child failure cancels siblings. A failed Outcome is ordinary data.
Acquisition in using is interruptible. After successful acquisition, release is
registered before use and runs once on completion, failure or cancellation.
Failed or interrupted acquisition owns any partial cleanup itself.

Cancellation requests native interruption and awaits execution and cleanup
settlement. Repeated cancel calls share that barrier; execution or cleanup failure
does not reject cancel. Result remains the failure observation channel.
fromPromise supplies an AbortSignal; callers must
cooperate with cancellation. Native failures, defects and interruption are not
converted into domain Outcome values. Exact native error aggregation and scheduling
are not normalized. There is no journal or persistence implied by this runtime.

Portable asynchronous cleanup uses composition.ensure or runtime.using. Yielding
from JavaScript finally during native interruption is not a portable guarantee.
Native shutdown handles physical resources; durable workflow cancellation and
its logical cleanup require a separate execution protocol.

The lifecycle acceptance journeys exercise pending acquisition cancellation,
release registration before use, and failure reporting while another finalizer
awaits a peer's close reply. Composition journeys cover scoped driver lookup,
middleware ordering, short-circuiting and typed argument/result rewriting under
both adapters. Acquisition-to-use context visibility and null/undefined context
semantics remain unresolved portability boundaries.

The Effect runtime supplies composition and Scope requirements internally. Other
native service requirements must be provided by the stack's operations before
entering this runtime; the HKT retains those requirements and does not erase them.
