# Hoot composition proof

An isolated implementation probe for RFC 001. It does not replace yo-tisyn's
current evaluator or register an application driver.

## What runs where

- The existing `compiled-frames` frontend compiles the developer generator in
  `fixture.mjs` to workflow Scheme, retaining its named effect sites and locations.
  Its existing JS backend also runs during preparation; no JS bytecode is sent
  to Hoot. Removing that unnecessary preparation dependency is follow-up work.
- The fixture replaces the generated entry invocation with a hand-authored Scheme
  caller. Both caller and callee are evaluated by `evaluator.scm` inside Wasm.
- `build.py` compiles the evaluator using the Scheme runtime's pinned Docker image
  and structured-module metering pass. Output stays in `.artifacts/hoot-composition`.
- `machine.mjs` loads fresh instances through the existing reflection bridge.
  It checks artifact/input hashes before loading. Host code marshals data; it does
  not execute workflow control flow.
- `driver.mjs` adapts the experiment to the existing workflow-driver. The stored
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
format v2 captures the cancellation-requested flag and explicit scope frames.

## Run

The pinned image must already exist (the scheme-runtime `wasm:build` command builds
it). Run from the repository root with the workspace Node version (24.22.0):

```sh
python3 experiments/workflow-kernel/hoot-composition/build.py
node experiments/workflow-kernel/hoot-composition/__tests__/composition.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/authority.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/scopes.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/finally.mjs
```

All four suites pass on Node 24.22.0 with no additional flags. The Scheme
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

Next: separate the Scheme-emission frontend from JS bytecode preparation and
define macro expansion and snapshot validation before broadening app integration.
Node 22 compiler compatibility is tracked in the
[Scheme runtime package TODO](../../../packages/scheme-runtime/README.md#node-compatibility-follow-up).
