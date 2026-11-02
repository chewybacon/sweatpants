# Footguns: decisions that compound complexity

This is a record of design traps and the boundaries that keep them manageable.
It is not a backlog of edge cases the framework must automatically handle.
Entries describe design constraints; they do not declare unimplemented APIs complete.

## FG-009 — Treating an attempt notification as ownership of a host

A delayed cancellation for a body attempt arrives after another run has started
logical cleanup. Aborting "the current host" can stop work whose authority was
never revoked. A local group failure can also interrupt physically nested siblings.

**Boundary:** Durable tree ownership, attempt settlement authority and native task
lifetime are distinct. Relay committed revocations to exact attempt subscriptions.
Physical stop addresses a particular execution; it does not confer retry authority.
Neither notification transport nor an activation driver establishes a global lease.

**Author responsibility:** Assemble scope lifetimes and signal routing explicitly,
handle interrupted runs, and arrange further advancement for logical cleanup. Use
an incarnation-specific address if introducing remote whole-execution stop. Preserve
protected attempt authority even when physical shutdown interrupts its IO.

See [hosting ownership](./hosting/OWNERSHIP.md) for evidence and unresolved race wiring.
Keep IDs stable and add a concrete example when recording a new trap.

## FG-001 — Making every race succeed

An answer races cancellation while a new conversation message is queued. Trying to
make every ordering succeed transparently introduces implicit retries, hidden command
ordering and guesses about user intent.

**Boundary:** Preserve accepted history and enforce journal authority. Reject stale
or conflicting operations. If an assembly cannot safely determine its next action,
fail explicitly and leave unresolved work observable. Do not turn ambiguity into
success or discard obligations to unblock a caller. An error after partial progress
does not imply rollback.

**Author responsibility:** Serialize conflicting commands, restrict the supported
interaction flow, or handle rejection and reread authoritative state. Disabling a UI
button helps the user but does not serialize another tab or server request. A general
distributed conflict-resolution system is not a prerequisite for a chat application.

See [journal cancellation and answer contracts](./durable/src/contracts.ts).

## FG-002 — Treating a batch as a transaction

Ten answers arrive in one request. Some are accepted before another fails validation
or encounters a revoked grant. A transport envelope cannot make writes across child
journals atomic.

**Boundary:** A convenience batch retains individual answer authority. Its contract
must expose accepted progress or a way to recover it; a thrown error must not imply
that nothing was accepted. Cross-journal all-or-nothing behavior requires a separate,
explicit guarantee. Collecting answers before requesting one advancement pass can
reduce chatter without promising that guarantee.

**Author responsibility:** Handle partial results and lost acknowledgements using the
individual answer contract. Do not blindly resubmit conflicting values or treat a
batch failure as permission to restart the whole workflow. Batch API shape remains
an assembly decision, not a required new transaction primitive.

See [interaction acceptance](./durable/src/contracts.ts) and
[typed answer ingress](./hosting/src/contracts.ts).

## FG-003 — Treating Send as an implicit answer or universal replacement

A tool is waiting for approval; the user sends a new ordinary message. That message
does not identify which of several pending interactions it answers. Replacing the old
turn can also hide cleanup that still needs input.

**Boundary:** Submission, exact-target answering and cancellation have distinct
meanings. Interrupt-and-queue is a conversation policy, not a kernel default. Queuing
a message is not itself a cancellation fence. A design must state which predecessor
outcomes permit admission and may reject unsupported states explicitly.

**Author responsibility:** Choose a supported flow and model-context policy. Starting
a successor while its predecessor unwinds requires an explicit concurrency policy;
the framework must not invent one to make Send always succeed.

The [conversation example](./acceptance/examples/file-conversation.ts) currently
supports completed predecessors only; it does not implement interrupt-and-queue.

## FG-004 — Treating cancellation as completed rollback

Cancellation may require further advancement, and cleanup may wait for input or
encounter uncertain delivery. A business commit may also have succeeded despite
logical cancellation.

**Boundary:** Cancellation intent, physical disposal, terminal settlement and business
compensation are different facts. Required repair must remain nonterminal until its
obligation is resolved or explicitly discharged. Successful cleanup and accepted waiver
must not be presented as the same business outcome. Arbitrary thrown cleanup errors
do not automatically become resumable repair waits.

**Author responsibility:** Declare required repair before cleanup returns, preserve
the business outcome, and define when compensation is safe. Use supported logical
cleanup rather than assuming physical disposal executes arbitrary durable `finally` work.

See [hosting compensation and repair](./hosting/README.md) and
[logical execution scopes](./execution/README.md).

## FG-005 — Resolving uncertainty with retries or critical regions

An external service commits, but its response is lost before journal acceptance.
Neither cancellation nor a local `committed = false` flag proves that rollback or
redispatch is safe. A critical region defers logical cancellation; it does not transact
with that external service.

**Boundary:** Preserve occupied attempt authority and fail visibly when safe progress
is unavailable. Do not equate occupancy with a dead owner: work may still be live
elsewhere. Timeouts and newer user messages do not authorize repeating unsafe effects.

**Author responsibility:** Supply idempotency, fencing, final reconciliation evidence
or an intervention path where the application needs recovery. Unsupported uncertainty
may remain blocked. Do not build automatic recovery by guessing what happened.

See [hosting delivery contracts](./hosting/src/contracts.ts) and
[Lua capability limits](./codemode-runtime-lua/README.md).

## FG-006 — Turning observation into execution ownership

A browser reads slowly or disconnects. If reading owns advancement, tool work can stall
or be physically interrupted. Conversely, a scheduling report can summarize one blocker
while hiding another branch's actionable interaction.

**Boundary:** State who owns execution separately from who observes it. Read-only
discovery exposes registered facts; it cannot advance a branch to create the next
question. A root report is not a complete interaction inventory, and persisted
nonterminal state is not proof that an owner is currently running.

**Author responsibility:** Choose request-owned or application-owned work deliberately.
Reconstruct accepted state after reconnect; do not assume transient stream delivery is
a durable acknowledgement. Define cross-journal observation consistency honestly.

See [hosting](./hosting/README.md) and [client capability limits](./chat-client/README.md).

## FG-007 — Promoting an experiment to avoid making application choices

A test introduces a response cap, sweep backoff, queue policy or retry wrapper. Moving
those lines into a framework helper can make a provisional product choice look like
a fundamental guarantee.

**Boundary:** Name the consumer, responsibility and guarantee before promoting an
assembly. A useful local helper is sufficient when no reusable semantic boundary has
been established. Middleware decorates policy; core authority cannot depend on an
optional installer. Passing acceptance does not approve every API shape in the test.

**Author responsibility:** Keep unresolved choices local. An awkward application flow
is evidence to investigate, not an instruction to invent another primitive or state machine.

See [assembly-driven design](./AGENTS.md#assembly-driven-api-design).

## FG-008 — Letting a design brief become an implementation diary

Sequenced plans and appended test reports eventually obscure which statements are
requirements, historical gaps or current guarantees.

**Boundary:** Keep the brief about behavior, scope, constraints, decisions and genuine
open questions. Put implementation order, progress and requirement-coverage evidence
in companion records. Preserve requirement IDs; do not silently convert a successful
experiment into a universal contract.

**Author responsibility:** Cite evidence and its limits. In-process reopen is not proof
of process-crash durability; native runtime coverage is not evaluator parity; a typed
contract projection is not proof of a browser-safe import graph.
