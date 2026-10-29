# Acceptance journeys

Add `*.acceptance.test.ts` journeys here. Exercise public package APIs through
protocol simulators running in the same process. Reusable rigs and fixtures belong
in `@sweatpan.ts/testing`. Simulate protocol peers, not internal implementation
methods. Tests own and dispose their resources and use deterministic scripted
responses and fault injection.

No unit tests, live provider calls, external services, deployed infrastructure or
subprocess-based test rigs. Recovery scenarios reconstruct the subject against
retained in-process state; they must not claim proof of real OS-process crash
recovery. Platform-specific behavior requires explicit evidence beyond a simulator.

Run `pnpm v2:test`. Empty collection intentionally fails. Add real acceptance
journeys as capabilities are ported; do not add placeholder tests or enable
`passWithNoTests`. The runtime journeys exercise shared application code through
both native adapters and an in-process scripted request/reply peer. Compile-time
acceptance fixtures additionally verify native mappings and invalid stack assembly.

## Move the entry point outward

Acceptance journeys enter through the highest implemented application boundary
that can express the behavior. As that boundary advances, migrate existing
journeys and retire their lower-level equivalents rather than accumulating a
permanent suite for every layer. Preserve behavioral and inference evidence,
not the old test shape or test count.

Durable recovery journeys now enter through `activateJournal`; replies enter
through `journal.accept`. They do not manually build accepted histories, update
recovery positions or resume Guests. Storage fault injection and protocol peers
remain below that entry point. Assembly may install middleware and evaluator
adapters without making their methods the subject's entry point.

Runtime and execution journeys remain transitional evidence for behaviors not yet
covered through application entry points: concurrent typed capability calls, scope
policy, unstarted disposal and multi-Guest composition. Move those
assertions outward when hosting/agent entry points can exercise them; do not keep
the lower-level journey once its replacement establishes the same behavior.

Hosted effect journeys now enter through `host.operations.run()`. Competing hosts,
late replies and lost acknowledgements are exercised there, with injected
transport behavior around the real attempt storage capability. Journal activation
remains the entry point for externally answered requests and evaluator/storage
fault journeys; handler execution belongs to hosting.

Participant interaction journeys enter through hosting as well: registration,
answering and invalidation use the public scoped API. They establish a local wait
without an execution attempt and the optional composition of external registration
followed by waiting. Invalidation tests prove reply fencing, not deadline scheduling
or logical cancellation/unwinding.

Resource lifecycle journeys now enter through `host.operations.run()` with real
journal acquisition and handler delivery. They cover pending/failed acquisition,
release registration, asynchronous release, sibling transport failure and cleanup
failure with inherited context. Each verifies that no authored outcome was
accepted and that a fresh host observes the occupied attempt. The former runtime
lifecycle file and overlapping runtime cancellation/resource tests are retired.

Live-attempt notification journeys remain distinct from host shutdown: invalidation
persists and prevents replacement, while ordinary host shutdown leaves occupancy.
They cover both subscription races, dropped/failed publication, repeat commands,
stale grants, accepted-first settlement, and subscription cleanup on success/failure.

Lua hosting journeys reopen retained journal records after acceptance but before the
host observes its settlement acknowledgement. Each new assembly creates a fresh
journal handle, evaluator, recovery API, effect definitions, installations, grants and host.
Lua submits named effect keys/input through a boundary decoder into the same admission
and delivery path as TypeScript. It consumes a transformed success and an authored
failure as Outcome data. Context parsing and handler middleware run once per delivery;
the success schema runs only for success. Replay-only, checkpoint restore
and unsupported-format replay fallback preserve distinct delivery scopes, cleanup
and exactly one scripted peer request per effect. These replace the earlier
uninterrupted multi-request journeys. Reopening is in-process evidence, not disk or
OS-crash durability; supported-format restore errors are not silently replayed.

Attempt, owned-child and Lua checkpoint journeys now use temporary real SQLite
files through createSqliteJournalRig. Reopen closes the connection and rebuilds the
store; connect supplies a second independent connection for controlled races.
The same durable journal binding backs memory and SQLite. Existing journeys cover
rollback after child writes but before parent acceptance encoding, fresh projection
binding, queued cancellation, stale grants and duplicate receipts after reopening.
These are in-process connection/transaction tests, not subprocess crash or disk-fault
evidence. No live service or external provider is needed.

Transaction instruction journeys enter through hosting and use the shared production
interpreter. They cover inferred results, lazy registration, callable middleware,
commit publication, and rejection of foreign/closed registrations. Existing owned
publication and async-storage journeys cover delayed acknowledgement, rollback and
joined physical cleanup on this same path. The prototype bridge and duplicate callback
mode are retired. The simulated peer does not establish interruption semantics for a
real asynchronous database COMMIT.

The effect-capabilities journeys use defineEffect from core and createEffectCapabilities
from hosting through their public package entry points. The standalone factory constructs immutable
runtime-independent declarations; host assemblies own installation, middleware and
grants. The same module-level definitions (one declared response, one inferred default)
run under both runtimes. Concurrent host scopes install distinct implementations and
middleware, and a later uninstalled scope fails instead of inheriting either handler.
A negative type fixture rejects a default implementation with an incompatible yielded
protocol while allowing a compatible replacement. Default closure dependencies remain
caller-owned; a declaration does not make native operations portable.

Named declarations use key/context/response. Handlers and their middleware return
Outcome; defaults infer success and failure types without explicit generics or a
required output schema. Schema-only declarations retain unknown failure data because
later scoped installation cannot change a declaration's static type. Replacement
handlers preserve the declared success/error contract. Handler inputs are normalized
context; successful values contain raw response input. The boundary transforms only
success values before acceptance, then delivers the authored Outcome as data.

Named failure journeys accept an authored failure, interrupt before Guest resumption,
and reopen without rerunning the handler or applying its success schema. Transport
exceptions and invalid bare returns do not settle; reopening leaves the unsafe attempt
occupied. Participant raw-answer ingress and owned-child projection use the same
Outcome reply convention. Exceptions are never converted into authored failures.

Concrete declarations now cover both elicitation schemas through ordinary installation
and middleware. The earlier dynamic-schema defineElicitation constructor and its special
types/slot map are retired. This suite no longer claims arbitrary
per-call schema support. Fresh assemblies rebind named definitions and recover accepted
answers without repeating delivery or validation. Granted aliases preserve callable
inference independently of definition identity. Grant admission is installed as outer child middleware, before routing. Denied
attempted, participant and owned-child deliveries acquire no delivery authority; the
request stays parked and can be fulfilled by newly authorized assembly after reopen.
Admission does not normalize schemas or execute work. Handler dispatch retains its
membership check too. Middleware can deliberately be omitted or bypassed by trusted
assembly; this is composable policy, not an unskippable authorization sandbox. Grants
are trusted assembly, not remote credentials.

Recorded work is available directly as ctx.record when assembly explicitly enables it
with grant(definitions, { record: true }); no separate record definition is authored.
Operation bodies must return an explicit Outcome; success and authored failure retain their
inferred types and are returned to the Guest as data. The transport carries that
Outcome as a successful delivery; a failed transport reply would throw into the Guest.
Fresh Guest acquisition installs a scope-owned pending-operation binding. Record
requests contain a required semantic key and ordered sequence. Replay rejects a changed
key at the same position before delivering accepted success or failure; repeated keys
in a loop consume distinct ordered outcomes without repeating accepted work. Two interruption windows prove
that accepted successes and failures replay without running work again, while unaccepted unsafe work
stays occupied. A combined journey records a file offer, invokes a named choice exchange,
reopens after accepting that choice, then invokes an inferred file-read exchange. Each
callback, handler and response transformation runs once through the same hosting path.
The peer simulates file delivery; this does not implement a filesystem adapter.

The owned callback journey supplies an authored clarification Guest through scoped
hosting child middleware. It performs a notification, then registers a participant wait.
Fresh assemblies reopen the same wait, accept a raw answer through the registered schema
pipeline, and reopen again before callback/parent completion. Notification, answer
normalization and parent projection each happen once. Routing/projection is still explicit
trusted assembly policy; there is no reusable callback authoring or authorization adapter.
The parent is host assembly, not a third authored Guest.

Local recording uses native generator operations through the same installed effect
pipeline as named handlers. The asynchronous journeys prove delivery-context access,
protocol-driven physical cleanup on cancellation, rejected revoked settlement, replay
without repeated execution, and binding invalidation when acquisition scope closes.
Type fixtures preserve result/error inference and reject incompatible native yields,
bare values and Promise functions. Untyped non-operations, malformed Outcomes and
nested recording fail before settlement; unsafe interrupted attempts remain occupied.

Remote closures, stronger source-site identity and checkpoint-only closure restoration
remain design work. Named declarations do not prove checkpoint restoration of granted
callable references. These journeys
establish in-process SQLite reopen, not OS-crash durability or exactly-once external work.

Retained/recovered Guest lifetime matrices exercise existing hosting authority,
cancellation, named-effect and Lua checkpoint journeys on both runtimes. Named-effect
reopen counts distinguish a retained live scope from repeated acquisition and require
all acquired scopes to be disposed. Lua counts distinguish checkpoint restoration from
continuing an already retained evaluator. Stale settlement, occupied attempts, prompt
invalidation, host shutdown and logical cleanup use the same existing journeys under
both policies. An additional interleaving accepts a result, pauses its host, lets a
competitor advance and commit cancellation, then resumes the original host: it follows
accepted history into cleanup and never delivers the cancelled approval. These are
in-process protocol simulations, not exclusive evaluator leases or remote placement.
