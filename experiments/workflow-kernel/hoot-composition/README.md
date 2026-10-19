# Hoot composition proof

An isolated implementation probe for RFC 001. It does not replace yo-workflow's
current evaluator or register an application driver.

## What runs where

- The `scheme-compiler` frontend compiles the developer generator in
  `fixture.mjs` to workflow Scheme, retaining its named effect sites and locations.
  It returns Scheme and source metadata directly. No bytecode backend is loaded
  during preparation or Hoot execution; `no-bytecode.mjs` enforces that boundary.
- The fixture replaces the generated entry invocation with a hand-authored Scheme
  caller. Both caller and callee are evaluated by `evaluator.scm` inside Wasm.
- `build.py` compiles the evaluator using the Scheme runtime's pinned Docker image
  and structured-module metering pass. Output stays in `.artifacts/hoot-composition`.
- `machine.mjs` loads fresh instances through the existing reflection bridge.
  It checks artifact/input hashes before loading. Host code marshals data; it does
  not execute workflow control flow.
- `driver.mjs` adapts the experiment to the existing program-backend-kernel. The stored
  journal test uses the ordinary authority bind, checkpoint persistence, and
  accepted-suffix recovery path over the memory Execution Store.

## Explicit state

The evaluator is a small expression/frame machine. Its environment table uses
integer identities; closures hold parameters, body, and environment identity.
Frames describe argument evaluation, calls, branches, sequences, and cleanup.
At an effect boundary, all of that is written as a Scheme datum inside a portable
string. Restoring reads data and exposes the boundary without executing steps.
There are no serialized native procedures or native continuation stacks.

Cleanup registrations belong to explicit logical scopes. Ordinary function calls
inherit the current scope; `scope` creates a new boundary. Scope exit drains
cleanup in reverse registration order. A cleanup can suspend, and cancellation
crosses call frames while draining logical scopes. Repeated cancellation during
cleanup records the request without abandoning its pending effect. Discarding
an instance does not execute cleanup.

Loops retain explicit test/body frames. Blocks allocate lexical environments per
entry; assignment walks parent environment identities. Thus loop-local bindings
remain distinct while closures can share an enclosing mutable binding. Snapshot
format v3 captures the cancellation-requested flag and explicit scope frames.

## Snapshot admission

Restore validates the candidate inside Wasm before assigning live evaluator state.
It requires exactly one datum, the pinned source and format, valid mode/counters,
contiguous environment IDs with older parents, unique binding names, known frame
shapes with valid environment references, valid direct closure/primitive bindings
and cleanup callables, and coherent portable parked/terminal boundary data.
Rejected candidates leave the previous computation intact.

Admission limits are 4 Mi Scheme string characters, 100,000 visited datum nodes,
and 256 nested pair-car levels; the existing Wasm fuel budget also applies. These
are experimental admission limits, not a memory quota or a guarantee that every
arbitrarily large running program can be checkpointed. Reader allocation occurs
before structural traversal. The validator does not establish reachability from
source, fully validate embedded expressions or all nested runtime values, or
provide authentication. Authority provenance and kernel/program identity checks
remain required; snapshots are not an untrusted code interchange format.

`__tests__/snapshot-validation.mjs` corrupts candidate states and checks rejection
without live-state mutation, then resumes the original computation and restores
cleanup and terminal snapshots. Existing scope/finally suites cover valid frames.

## Program input

`machine.start(source, input)` binds portable JSON input as `%input` in the root
lexical environment. Omitted input defaults to null for the direct machine API.
The shared driver passes the attachment input; no source interpolation or code
specialization is needed. The compiler's `entryInput: true` entry call already
passes `%input` to the developer generator's second parameter.

Input uses the same encoding as effect replies, preserving nested objects, arrays,
null, and finite binary64 numbers. It is ordinary environment data in the snapshot.
Restore receives the pinned source and snapshot, without reinjecting input or
rerunning initialization. The shared driver's checkpoint identity binds the
attachment input; the low-level machine remains a trusted snapshot reader.

`values.mjs` covers direct and compiled input across fresh instances.
`backend-composition.mjs` passes input from a Hoot parent to a routed Effection
child, parks, replaces authority/backend instances, and returns both the child's
structured result and the parent's retained input.

## Run

The pinned image must already exist (the scheme-runtime `wasm:build` command builds
it). Run from the repository root with the workspace Node version (24.22.0):

```sh
python3 experiments/workflow-kernel/hoot-composition/build.py
node experiments/workflow-kernel/scheme-compiler/__tests__/emit.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/no-bytecode.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/confirm-action.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/installed-effect.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/values.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/snapshot-validation.mjs
node experiments/workflow-kernel/scheme-data/__tests__/values.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/composition.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/authority.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/backend-composition.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/scopes.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/finally.mjs
```

These suites run on Node 24.22.0 with no additional flags. The Scheme
runtime package's 15 tests also pass on that version. Earlier Node 24.14.0
validation required `--experimental-wasm-exnref`; Node 24.22.0 needs no such flag.

The expanded evaluator triggers a fatal `is_int9(x)` assertion in Node 22.21.1
on arm64 in V8's Liftoff `PrepareTailCall`. `--no-liftoff` remains a diagnostic
workaround for that version, not a production runtime fix. Node 22 compatibility
remains an open TODO; this finding concerns the experimental binary.

The negative incompatible-source test intentionally produces a Hoot error trace.
The stored proof starts once, restores three times into fresh instances, and
visits reserve → approve → release in both completion and cancellation cases.

## Proven and not proven

Proven: compiled developer callee + Scheme caller, captured caller locals and
callee closure environments, cleanup suspension, restoration without prefix
execution, cancellation, and authority-owned checkpoint persistence. The direct
proof inspects nested call names and compiler effect-site metadata; no visualizer
UI integration is claimed.

This is a trusted-fixture experiment, **not a safe general Scheme evaluator**.
Only the fixture's constructs and value bridge are implemented. There is no macro
expansion, general syntax/arity validation, deep snapshot validation, arbitrary
exception transport, heap collection, allocation quota, or source migration.
The scope suite compares six compiled patterns against native Effection on
normal completion and against the JS evaluator in normal/cancel/repeated-cancel
paths, restoring fresh Wasm at every boundary. It covers inherited scope ownership,
nested scopes, loop cleanup, break/continue, per-iteration bindings, and shared
closure mutations. A separate authored Scheme case proves closure aliasing.
The finally suite adds nine compiled patterns: ordinary completion, early return,
body throw, cleanup throw, both throwing, nested finally, continue, break, and
multiple failing ensures around a failing finally. It compares normal execution
and host-rejected effects against native Effection, and cancellation at each
distinct effect against the reference evaluator. Every effect and terminal
boundary is restored into fresh Wasm without stepping. Failing ensures continue
draining in reverse registration order; the last failure wins. A finally frame
stores the pending completion, so normal cleanup resumes its original control flow.

This is not full Effection conformance: native cancellation parity, concurrent
children, and whole-program tail-call behavior remain unproved. Errors from
invalid evaluator operations still trap; only explicit throws and portable host
rejections participate in workflow unwinding.
Snapshots currently include source and retain allocated environments; their size
is not evidence of a production storage budget. Wasm GC and Hoot reflection are
required. Cloudflare/workerd execution has not been tested for this new kernel.

Next: define macro expansion and snapshot validation before broadening app
integration. The JS bytecode backends remain explicit reference-test consumers
of the Scheme emitter, not dependencies of the Hoot execution path.
Node 22 compiler compatibility is tracked in the
[Scheme runtime package TODO](../../../packages/scheme-runtime/README.md#node-compatibility-follow-up).

## Developer confirmation function

`confirm-action.mjs` emits a developer `confirm_action` generator as definitions
only and composes it with a hand-authored Scheme caller. The caller retains a
local label while the developer function elicits approval, then uses its boolean
result to choose a response. Both call frames remain visible in the snapshot.

The test validates approval envelopes with Zod before resuming. Invalid replies
leave the snapshot unchanged; acceptance, negative approval, and decline survive
fresh-instance restoration. A separate invocation checks the developer function's
boolean output. These are explicit host validators, not inferred TypeScript
schemas or automatic validation of internal calls. The caller is a controlled
stand-in for model output; no live model or application UI is involved. This
fixture uses the machine directly; the existing authority suite separately
exercises journal recovery. General symbol linking and tool registration remain
unimplemented.

## Installed host effect proof

`installed-effect.mjs` compiles an imported typed-effect reference and runs it
through the shared driver, stored authority, and existing durable-effect registry.
The test host sends no external messages. It holds its own test credential and
returns a receipt; neither the emitted program nor persisted snapshot contains
that credential. A following elicitation parks with the receipt in local state.
Reopening the authority and restoring a fresh evaluator completes with that receipt
and leaves the host execution count at one. The snapshot is taken after the effect
has completed; this is not a crash-in-the-middle or exactly-once delivery proof.

Negative cases reject an unknown compiler binding and shadowed import, reject
invalid effect input at the authority before execution, and propagate a host denial.
The host-denial case exercises an implementation returning an error, not a full
principal/ACL integration. Structured host errors now round-trip as portable JSON objects. Ambiguous external completion and production credential
providers remain outside this proof.

## Portable value contract (snapshot v3)

Objects use `(json-object ("key" value) ...)`, arrays use Scheme lists, and null
uses the `json-null` symbol. JSON strings that resemble these markers remain
strings. Object keys such as `__proto__` are defined as ordinary own properties
on decoding. Compiled `object` forms and `json-field` use the same representation
as host replies. Empty objects, empty arrays, null, and false remain distinct.

The host codec accepts finite numbers, well-formed Unicode strings, booleans,
null, dense arrays, and plain objects with enumerable data properties. It rejects
undefined, functions, bigint, nonfinite numbers, cycles, getters, live host
objects, sparse arrays, and symbols before resuming. It bounds traversal to 128
levels and 10,000 values; this is not comprehensive snapshot or memory hardening.
Negative zero follows JSON normalization to zero.

Host numbers are encoded as exact Scheme integers/rationals preserving their
IEEE-754 value. This avoids an observed decimal-reader drift for `1e-30`. Boundary
decoding rounds rationals to binary64, including subnormal values. Transport
fidelity is tested; full JavaScript floating-point arithmetic semantics inside
the evaluator are not established by this work.

Snapshot format v3 replaces v2 for the new object/null representation. The pinned
Wasm digest also changes. No compatibility reader or migration is provided.
The installed-effect proof now uses nested object input/output, and the value
suite restores all value kinds into fresh Wasm instances without stepping.

## Shared inspection projection

`inspection.mts` projects Hoot's explicit state into the `ExecutionInspection`
contract exported by `workflow-kernel`. `machine.inspect(boundary)` returns this
as `execution` alongside the Hoot diagnostics. The supplied boundary is the
kernel adapter's actual transition result; its live suspension ID is excluded
from the projection. Inspection does not step the evaluator or authorize recovery.

Calls, lexical environments and unwind continuations remain separate. Scope
registration, running cleanup and finally are distinct variants; scope ownership
is not fabricated after Hoot discards it. Closures retain their environment ID.
The projection caps collections at 2,000 entries overall and display summaries
at 2,000 characters / depth 16, reporting truncation. These are presentation
limits, not snapshot admission or sandbox limits. The boundary payload and raw
Hoot diagnostics retain their existing limits.

The lab's call-stack, binding and cleanup panels use this shared projection;
its continuation frames and step counter remain Hoot diagnostics. Run the new
proof with `node experiments/workflow-kernel/hoot-composition/__tests__/inspection.mjs`
after building the Hoot artifact, or use `pnpm --filter yo-workflow execution:test`.

## Linking and authoring composition

`linker.mts` implements `WorkflowLinker`. It accepts Scheme callers and the current
versioned definition format, explicitly registers compiled functions versus host
capabilities, verifies entries, rejects duplicate public/private names and deduplicates
identical definition modules. It parses caller forms before embedding them in the
host registration envelope; evaluator validation and effect-free preflight still
own language admission. The current evaluator's host-call version is 1, so other
versions are explicitly rejected. Registered public names currently use a bounded
symbol grammar; arbitrary symbol quoting is not supported.

`authoring.mjs` supplies the lab's source validator, linker and program factory.
Node and Cloudflare compose those same seams with their existing machine loaders.
The application preflights through `WorkflowKernel`, not the Hoot machine API.

Programs now use the shared `createKernelProgramBundle`/`loadKernelProgram` content
identity helpers. This changes program digests for newly prepared programs. No
migration of existing pinned executions is promised. The evaluator, guest semantics,
Wasm binary and snapshot format are unchanged. Run `__tests__/linker.mjs` or the
lab's `execution:test` for linking rejection and fresh-restore evidence.

Hoot linking implements the Effection `WorkflowLinker.link` operation. The pure
Scheme registration transform stays internal to the adapter. The lab yields
linking during validation/preflight and bridges its Promise service entry points
with `run()`, so another target can wait for caller checking or compilation.
