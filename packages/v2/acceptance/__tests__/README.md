# Acceptance journeys

Add `*.acceptance.test.ts` journeys here. Exercise public package APIs through
protocol simulators running in the same process. Reusable rigs and fixtures belong
in `@sweatpan.ts/testing`. The acceptance-only `runtime/assembly.ts` fixture is an
exception: it assembles both concrete native runtimes without adding those
runtime dependencies to the portable testing package. Keep its local application
types beside it. Simulate protocol peers, not internal implementation
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

## Authored tic-tac-toe application

`applications/tic-tac-toe.acceptance.test.ts` assembles one authored game from a keyed
recorded coin flip and two typed `defineEffect` declarations. Hosting delivers model
moves through a protocol peer and routes user moves to durable participant waits.
Participant ingress uses the effect schema pipeline before committing its answer.
No game-specific production API or builder is introduced.

Both coin outcomes run through a complete game on Effect and Effection, with normal
play, SQLite reopen at a player wait, and host interruption after accepting a model
move but before acknowledgement. Assertions cover final boards/move order, malformed
and occupied-cell replies, one coin execution, no repeated model delivery, preserved
participant grants and joined Guest disposal. Coin and model/player choices are scripted;
this proves local composition/recovery, not model quality, remote transport, UI behavior
or OS-crash durability. Schema-only effect failures remain unknown until narrowed.

Effect-answer ingress is covered by `hosting/answers.acceptance.test.ts` on both native
runtimes. Strict parsing rejects coercion; transforming schemas persist their returned
value. Forged grants and ungranted effects reject before schema execution. A controlled
async validation race proves final settlement rejects revoked authority. Reopened and
terminal duplicate submissions resolve their original stored request; conflicting
normalized answers reject. Replay does not rerun response schemas, and ingress does
not execute handlers or reparse request context. Tic-tac-toe now uses this middleware
instead of installing a temporary answer handler. Structured authored failures compile
through the returned ingress view while the transport error remains string; they skip
response parsing and survive storage, duplicate submission, and replay.

`applications/tools.acceptance.test.ts` uses public `defineTool` from
`@sweatpan.ts/tools`, with provisional acquisition assembly kept in the journey. The inferred body composes typed capabilities, typed
elicits and the existing per-Guest recording grant. Both runtimes exercise direct and
middleware-wrapped acquisition through ordinary owned-child hosting. SQLite reopen at
participant waiting and after answer acceptance preserves normalized child input,
recorded values and handler outcomes. Counts establish one recorded execution, one
external read, one input transformation, one terminal projection and joined Guest
lifetimes. Registered `ctx.scope` cleanup runs on completion and stays dormant on
parking/disposal. Remote placement/transport, client code splitting and checkpoint
restoration of inline work remain outside this evidence.

The tool application additionally exercises recorded Promise factories through
`ctx.await(start, { record: { key } })`, lowering directly to the existing recording
grant and host runtime. Accepted values are not recomputed on replay. A rejected
Promise leaves its attempt unsettled and is not redelivered on reopen. Unrecorded
Promise execution and its separate evaluator lifecycle adapter are deferred.

Recording cancellation recovery is also exercised with SQLite reopen: an unsettled
body recording is cancelled, registered cleanup records a Promise result, and another
reopen after cleanup acceptance replays that value without repeating the callback.
This covers abandoned per-Guest recording bindings as well as retained nesting guards.

`applications/tool-admission.acceptance.test.ts` starts at public tool admission, then
runs recorded work and participant elicitation across fresh assemblies. Memory and
SQLite retain normalized input before initial execution and through completion;
recovery never revalidates it. A separate two-connection SQLite journey lets an earlier
submission finish validation late and proves it cannot replace the winning input.

The root tool admission journey also runs with `installElicitHandlers` in automatic
and participant modes. Inner scoped handlers override outer wait policy and restore
it on exit. Automatic handlers receive normalized context; both automatic and later
participant answers normalize responses once, and terminal replay repeats neither.

`applications/mounted-tool-stream.acceptance.test.ts` is a provisional authoring tracer,
not a public mount or client plugin API. A local mount uses existing admission, hosting,
scoped acquisition and participant policy. A separate transport publishes registered
waits on a cloned-data ReadableStream after Guest disposal. A separately attached typed
client validates request context, invokes its handler, and submits an authored answer
through the mount's existing answer ingress. No callback closure crosses the stream.

The same journal survives disconnect before publication, after publication and after
answer acceptance. Reconnect republishes pending authority; a fast reply is valid as
soon as the frame appears. Lost acknowledgements permit duplicate submission without
rerunning the Guest or recorded work. Client-local reply caching avoids repeated UI work
within this client instance; it is not durable client-side deduplication. This does not
implement sockets, backpressure, authentication, browser-safe contract splitting or a
persistent response-event log. Reconnect reconstructs current pending state.

## Hosted placement default

Hosted/application journeys use testing.createHostedRecovery, which acquires local
callback/grant bindings in the host scope and advances the Guest through the production
connection and asynchronous local byte transport. createHostedExecution supplies the
same placement for evaluator/checkpoint assemblies. Use its checkpoint adapter, not the
underlying evaluator adapter, when recovery holds a proxy Guest.

Direct acquisition remains intentional in low-level evaluator, scoped-execution and
retention tests. Parked mount/admission experiments are not promoted by this migration.
Connection conformance runs against both local bytes and MessageChannel; worker fault
journeys exercise the latter. A new transport should add conformance and a few lifecycle
integration journeys rather than duplicate every authored workflow scenario.

## Authored recording and group recovery

`applications/recorded-tools.acceptance.test.ts` replaces the lower-level recording
replay/identity matrix and combined file-exchange journey. Bodies use `defineTool`,
`ctx.record`, typed elicits and capabilities through `createToolAcquisition` and
connection-backed hosting. Attempt middleware still controls the exact interruption
before or after acceptance. Explicit/positional identity, structured failure inference,
occupied unsafe attempts, changed-key rejection and one-time normalization retain
their original assertions. Invalid erased callbacks and native operation lifecycle
remain targeted hosting journeys.

The authored inline-all recovery journey also verifies distinct child identities,
rejection of reordered definitions and alternate delivery species, and no group
acceptance before every branch finishes. It replaces the corresponding basic
owned-all hosting journey; specialized cancellation, protected branches and
transactional projection rollback remain separate evidence.

## Pinned program acquisition tracer

`applications/program-acquisition.acceptance.test.ts` explores acquisition through an
ordinary scoped API and placement middleware, with no new production registry API.
A provisional content reference includes Lua source, alias-to-effect IDs and the actual
Wasm artifact digest. The existing journal program field pins that reference; admitted
input comes from the journal rather than the current caller. Assembly resolves and
checks the artifact before acquiring a Guest.

Both runtimes exercise local bytes and MessageChannel placement. Missing and changed
artifacts reject before acquisition/delivery, including after reopen. Interruption after
acceptance proves fresh acquisition replays the first answer without redelivery and
continues with the admitted input. Replay-only cases install no checkpoint adapter. A terminal
journal returns its result even when the executable is unavailable.

Worker startup data now crosses the production Guest connection's initialization
command; local pinned assembly still detaches invocation data before evaluator entry.
This is not a real worker launcher or an authenticated artifact protocol. The content-reference recipe is provisional, not a portable manifest
format. Schema/decoder and runtime compatibility policy still require explicit design
before promoting an artifact resolver into production.

The tracer now consumes execution's `ProgramInvocation<Input>` contract. A declared
contract revision covers the input/result decoders and effect schemas in addition to
source/bindings/evaluator identity. Changed contract revisions reject both initially
and after reopen. Successful recovery switches local-to-worker or worker-to-local,
showing placement is independent of the pinned replay reference. The revision is a
trusted compatibility assertion, not a computed digest of schema implementation code.

The same journey now includes checkpoint restoration through `createProgramExecution`.
Both fresh acquisition and restore use a scoped resolver returning the actual artifact
reference. Wrong source/contract references and missing artifacts reject before entering
the evaluator. A missing advertised format rejects; an evaluator restore failure
propagates without fresh acquisition or delivery. Successful restoration reconciles the
accepted suffix and crosses local/worker placement without acquiring a fresh Guest.
Capture stays associated with the original/restored evaluator rather than resolving a
new instance. Public type consumers preserve input, outcome and checkpoint state types.

Worker initialization uses the same ordered connection as advancement. Focused worker
journeys reject malformed invocation data, advancement before initialization and attempts
to retarget an initialized incarnation. Lost/invalid initialization acknowledgements join
termination without resolving an artifact or starting a Guest. Existing application
replay/restore journeys use the server-owned resolver and check detached invocation data.

## Tool revision ownership experiment

`applications/tool-revisions.acceptance.test.ts` keeps logical tool naming separate
from an exact executable/contract/evaluator reference. Two authored definitions have
the same logical ID but different bodies, input transforms and approval schemas.
The application selects a deployment default only for a new invocation and persists
that selection before journal admission. The journal pins the reference and normalized
input. A reservation surviving interruption before admission retains its revision on
retry, even after the default changes. This is an application-local reservation, not a
new journal primitive or a shared admission transaction.

On both runtimes, the old tool parks, the default changes, and a new invocation uses
the replacement. SQLite reopen preserves the old reference, input and question grant.
Recovery uses `createProgramExecution` to reject a mismatched resolver result before
acquisition; missing artifacts fail without falling back to the current default.
Answer ingress independently selects the original contract: the replacement's valid
answer is invalid for the old question, and vice versa. Accepted reads are not repeated.
An application read of a completed journal needs no executable; answering still needs
the pinned contract, so code removal is not a universal retention policy.

The responsibility split explored here is: authors name and declare tools; build
tooling identifies executable and contract artifacts; deployment chooses defaults
and retains an exact-reference inventory; admission pins the selection; recovery and
answer ingress resolve that pinned reference. Fixture references are SHA-256 digests of
deterministic package-manifest bytes covering the entry point, contracts, evaluator and
declared dependency identities. Every nonterminal lookup verifies those bytes before
returning the acceptance-local executable. The fixture still does not serialize or
independently reconstruct arbitrary JavaScript closures. Dependency acquisition,
schema-transform implementation identity, build reproducibility and migration
compatibility remain open. Changed host policy is not silently included in the digest.

The same file also exercises hosted chat through an acceptance-local build adapter.
It creates a separate executable declaration with `defineTool(artifactReference)`,
retaining the authored schemas, capabilities, elicits and body. It does not mutate
the author's definition or replace only its `id` while leaving an incompatible call
builder. The authored logical name and model-facing name remain stable. Existing
`createChatToolBinding`, interaction discovery and `resolveToolExecution` consume the
executable declaration, whose ID matches the child's persisted program. No production
contract change was needed for this composition.

Trusted chat admission pins the selected catalog reference in root input before the
first model response or child creation. Each resumed chat rebuilds its catalog from
that input, never from the current deployment default. This policy pins the catalog
for the whole chat execution; it does not select newer revisions between tool batches
of that execution. A chat admitted before deployment but first run afterward still
uses its original catalog. New chats select the replacement.

Both runtimes prove old/new child program identity, schema-correct discovery and
answers, wrong-owner rejection, unchanged normalized inputs and accepted effects,
correlated final model results, and duplicate answers after terminal reopen. Missing
or digest-mismatched artifacts fail run/discovery/answer resolution without acquisition
or provider delivery. Direct `resolveToolExecution` rejects an inventory entry carrying
the wrong executable ID. Terminal reads can return accepted results without code;
answer/discovery assembly still requires retained contracts. A real bundler/loader,
dependency acquisition and rewriting (including nested tool calls), independently
loadable schema code and contract-only retention remain unproven. No generic versioning
API, migration or automatic advancement is introduced.

## Package shape

The package retains the standard `contracts.ts`, `apis.ts`, and `types.ts`
scaffolds and its build entry point. Empty scaffold files do not represent
implemented capabilities; journeys and compile-time consumers provide the evidence.

## Concrete activation consumers

`applications/request-consumer.acceptance.test.ts` runs validated request commands
through direct request-scoped reconciliation and returns finite projected JSON.
Observe reads accepted presentation without acquiring a Guest. Receipt-bearing
pagination stops at a captured accepted-history endpoint, independently of later
writes. One entry and a 2048-byte encoded response cap bound each response, not the
memory required to decode an individually large stored value. If a value exceeds the
response cap, an explicit oversized-entry marker retains its sequence and receipt
and advances the cursor. The full accepted value remains in the journal; this consumer
does not offer separate value retrieval. Approval and later history remain accessible.
If envelope metadata alone exceeds the cap, publication still fails. Lost responses,
concurrent Resume, abort cleanup and occupied recovery run under both runtimes.
Interrupting an unsafe effect can leave its attempt occupied after cleanup; Resume
never authorizes retry. An authorized operator decision or application-owned execution
is needed where request disconnection must not strand delivery. Cooperative iteration
budgets do not prevent interruption during an unsafe effect.
These are in-process Request/Response objects, not a live HTTP adapter. Live output,
production authorization and nested interaction routing remain application work.

`applications/sweep-consumer.acceptance.test.ts` owns application SQLite catalog,
cursor and token-keyed backoff tables. One designated owner visits one root per tick,
gates execution on admission, and rebuilds assembly after connection reopen. A persisted
upper ID bounds each sweep so newly enrolled higher IDs cannot postpone wraparound.
Failures, occupied, invalidated, yielded and unadmitted pending intent receive a ten-tick
delay keyed by the pre-drive token; new intent bypasses the old delay. Each tick still
visits at most one root; the caller owns recurring cadence. Unadmitted roots without
intent are cheap idle visits. Catalog retention and capacity remain application policy.
It proves
discovery without prompt wakeups, traversal across restart, answer recovery, advisory
telemetry loss, and new-token bypass of old backoff without unsafe redispatch.
Deadline signals exercise cooperative interruption and joined cleanup; they do not
contain synchronous hangs or nonterminating cleanup. A recurring deployed trigger,
concurrent sweep ownership and process-loss supervision remain platform work.
The reusable `createSqliteDatabaseRig` owns only the temporary database lifecycle;
consumer policy stays in these application journeys.

`applications/file-chat-sweep.acceptance.test.ts` connects the existing file-chat
assembly to activation reconciliation and persisted catalog traversal. The shared
application-local `examples/persisted-sweep.ts` also drives the original sweep
consumer; it owns only catalog enrollment and a finite, one-root-per-tick cursor.
Backoff remains with the original consumer, and a designated caller owns invocation
cadence. Neither example supplies concurrent sweep ownership or a deployed trigger.

On both runtimes, a nested file answer is accepted and its response lost without
driving chat or sending a wakeup. After SQLite reopen, later sweep invocations find
the root, advance the answered branch and retain its sibling's cleanup question.
Answering that question through another lost response lets a fresh sweep complete
the chat. Duplicate answers retain their receipts, sampling is not redelivered, and
terminal acknowledgement/idle visits acquire no Guest. A physically interrupted
sampling attempt remains occupied on the next sweep, with pending intent and no
redispatch. This is local assembly/reopen evidence, not process-crash recovery,
autonomous scheduling, a transport adapter or a new production primitive.

Projection and scheduling policy are now scoped middleware on application-local APIs.
The request assembly constructs one projection facade; its default returns wire entries
unchanged. The installed bounded-projection middleware can replace oversized values
with markers, or another request scope can install a summary policy. The consumer owns
endpoint validation, cursor advancement, JSON encoding and the final byte cap regardless
of installed projection policy. Journal presentation still exposes accepted outcomes.

The sweep assembly constructs one scheduling facade. Each visit supplies the same intent
API to scheduling middleware and reconciliation. Backoff middleware reads the pre-drive
token, suppresses matching delayed work and records a delay after uncertain/yielded or
unadmitted results. A tick owns a child scope for its installed policy; alternate delays
leave no middleware installed on the next tick. The consumer owns admission checks,
finite traversal and checkpointing, including failed middleware observations. Reopening
reconstructs the facades bound to the new connection. These contracts remain local until
another consumer demonstrates shared semantics; neither policy changes delivery authority.

## Reconnecting a conversation viewer

`applications/conversation-reconnect.acceptance.test.ts` moves observation and
answer submission through a minimal headless client backed by the existing
`examples/file-conversation.ts` assembly. `examples/file-conversation-view.ts`
contains provisional application projection and client state, not a new framework
session or transport API. The simulated boundary JSON-round-trips requests and
responses. Advancement remains an explicit, independently owned server action.

A finite observation captures the current turn catalog, reads each root's accepted
history prefix, and separately discovers waiting descendant questions. It projects
user prompts, accepted assistant text and tool-call labels, plus allowlisted file
question context. It excludes reasoning, tool arguments, raw failures and executable
schema objects. Assistant IDs combine root identity with accepted receipts; question
IDs combine descendant identity with the exact resolution grant. Each turn projects
only its own accepted samples, avoiding duplication of cumulative model history.

Both runtimes demonstrate disconnect during sampling without stopping its owner,
reopen while a tool waits, fresh-client reconstruction without Guest acquisition,
wrong-conversation/root rejection, answer acceptance followed by acknowledgement
loss, duplicate receipt recovery and conflicting answer rejection. Reconnect removes
the accepted question before further advancement and still reports the root running.
An older delayed refresh cannot overwrite a newer observed view. Explicit advancement
then completes chat; repeated reads, reopen and a second turn preserve message identity
without duplicates or resampling on observation.

The caller authorizes conversation access; grant identifiers are correlation, not
credentials. Child discovery and root history are separate snapshots, not an atomic
whole-tree view or an authority lease. A displayed question can become stale; answer
validation remains server-side. Empty questions do not imply completion. Full refresh
replaces client state; there is no cursor protocol, pagination, automatic reconnect,
optimistic answer acceptance or transport retry. Projection of tool results/media,
byte limits and archival retention remain product work. The view is coupled to this
application's pinned recorded-chat/v1 protocol, not a generic journal decoder.

Evidence is a serialized in-process peer and real SQLite connection reopen, not a
browser, React hook, deployed HTTP service or OS-process crash test.
