# RFC 001: Shared Scheme workflow kernel

Status: proposed working theory, pending the composition proof below.
Date: 2026-10-15

MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY express RFC 2119 requirement levels.
These requirements describe the target architecture, not completed capabilities.

## Intent

Model-authored Scheme and compiled developer-authored generators should compose
inside one embedded evaluator. Sweatpants retains its journal, effect execution,
and authority model. This is an evaluator integration, not a replacement host.

## Compilation and execution

```text
Build time:
  Scheme implementation of the workflow evaluator → Hoot → kernel.wasm

Workflow preparation and execution:
  supported JS/TS generator → workflow Scheme ─┐
                                              ├→ evaluator inside kernel.wasm
  model-authored workflow Scheme ──────────────┘
```

- The initial kernel MUST be implemented in Scheme and built to Wasm with Hoot.
- The developer compiler MUST target a documented workflow Scheme dialect.
  It MAY use intermediate ASTs or control-flow representations internally.
- Both authoring paths MUST converge on the same executable representation
  inside the kernel. The kernel SHOULD perform expansion, validation, and lowering
  in Scheme. The exact internal instruction format remains open.
- The kernel MUST support loading workflows without rebuilding its Wasm module.
- Unsupported source constructs MUST produce explicit diagnostics. This RFC
  does not promise arbitrary JavaScript, full Scheme, or unrestricted host access.
- Other language frontends MAY target the same dialect if they preserve its
  documented value, control-flow, effect, and cleanup semantics.

## Embedded execution and portable state

- The host MUST drive execution through the pull-based kernel/driver contract:
  advancing returns an effect boundary or terminal outcome; resuming supplies a
  result to the suspended execution. The existing Effection Operation interface
  MAY wrap these advances.
- At supported suspension boundaries, all state needed to continue MUST be
  explicitly representable: program position, calls, locals, closure environments,
  scopes, pending cleanup, and completion/cancellation state.
- Captures MUST be portable data, bound to program and kernel-format identities.
  They MUST NOT require preserving native Scheme/Wasm stacks, host closures,
  process handles, or the original instance. Shared references MUST retain their
  semantics; unsupported values MUST be rejected explicitly.
- Restoring a compatible capture MUST reconstruct its boundary without executing
  the captured prefix. Wasm memory dumps are not required by this design.
- Disposing compute or parking MUST NOT itself trigger logical cancellation or
  workflow cleanup. Cancellation MUST use the defined unwind protocol, including
  recorded cleanup effects when cleanup suspends.

## Composition, effects, and visualization

- A compiled workflow tool MUST be callable as an inspectable function within
  the shared evaluator. A capture inside that callee MUST retain its caller too.
- Native tools and MCP calls MAY remain opaque external effects. Compilation
  into the kernel MUST remain optional for existing tools and drivers.
- Observable external work and nondeterministic inputs MUST cross journaled
  effect boundaries. The kernel MUST NOT independently accept outcomes or write
  the journal. Publication and restoration MUST use authority-verified positions;
  accepted history after a capture MUST be applied as a suffix.
- Program artifacts MUST expose function boundaries, effect sites, branches,
  loops, and source mappings. Execution positions MUST reference that metadata
  so the visualizer can show steps inside a compiled tool and its suspended call
  path. Layout and presentation details remain outside the kernel.
- Incompatible captures MUST be rejected explicitly. Safe migration across code
  changes is a later feature; this RFC does not promise it.

## Installed APIs and host-owned capabilities

- The target compiler MUST support operations installed through the SDK context
  and existing typed-effect contracts. Bindings MUST derive from declared
  installation metadata; recognizing a method name alone is insufficient.
  This is a target requirement, not a claim that all SDK operations are implemented.
- A supported developer helper SHOULD compile to a named Scheme function whose
  frames remain inspectable. An installed host effect MUST remain an opaque
  invocation identified by its contract, portable input, and source site.
- The host MUST resolve the installed implementation, validate its contract, and
  enforce authentication and authorization. A serialized operation reference
  MUST NOT itself grant permission. Loading or sharing a workflow MUST NOT grant
  another user's integration access.
- Credentials and live resources SHOULD remain in host implementations. The
  kernel MUST NOT require secrets, sockets, clients, or host closures in its
  portable state to invoke an installed API. Workflow inputs, accepted outputs,
  and locals can still contain sensitive data: portable and credential-free
  MUST NOT be treated as sufficient authorization to disclose a snapshot.
- An already accepted outcome MUST be supplied from journal history on recovery
  without re-executing the host implementation. At an unaccepted frontier, the
  existing effect retry and indeterminate-outcome contract MUST govern execution.
  Recording a result MUST NOT be described as exactly-once external execution.
- Unknown delegation MUST fail compilation until an execution binding is known.
  The compiler MUST NOT silently wrap arbitrary generators as single recorded
  callbacks: nested yields, cleanup, and recovery semantics must be preserved.

`ctx.record` callback lifting and a `"use effect"` directive remain proposals.
A future callback implementation MAY capture portable workflow data explicitly
and obtain resources from its installed host environment; it MUST NOT rely on
serializing a live JavaScript closure. Type signatures alone do not establish
purity, durability, or retry safety. Existing typed effects are the first
implementation target; new authoring syntax is not required for this boundary.

The next proof SHOULD invoke an installed effect, park/capture the caller, restore
with an accepted outcome, and show that execution stays on the host. It SHOULD
cover rejected authorization and ambiguous external completion without weakening
existing journal contracts. SDK sampling, notification, logging, and other
operations MUST preserve their individual streaming and persistence semantics;
they MUST NOT all be assumed to be ordinary final-value effects.

## Existing evidence and first proof

The app already evaluates model-authored Scheme in Hoot and captures live
continuations; fresh-instance recovery currently uses journal replay. The JS
reference evaluator separately proves portable explicit state, cleanup recovery,
and authority-owned checkpoints. Those paths have not yet converged.

We SHOULD retain the JS evaluator as a reference for semantic comparisons. The
first Hoot integration MUST demonstrate this complete sequence:

1. A Scheme-authored caller invokes a compiled developer workflow.
2. The callee suspends at an elicitation with live locals and pending cleanup.
3. The authority persists its checkpoint; the Wasm instance is discarded.
4. A fresh instance restores both caller and callee, consumes accepted results,
   completes the callee, and returns into the Scheme caller without prefix replay.
5. Metadata identifies the nested call and suspension; cancellation executes
   required cleanup, while disposal alone does not.

The exact dialect, macro pipeline, closure encoding, and mapping from the current
compiler remain implementation questions. If this proof contradicts the working
theory, we MUST revise this RFC before expanding the implementation. General
migration, raw memory snapshots, and a broad language redesign are out of scope.

## Iteration 1 evidence

The [Hoot composition probe](../../packages/flowmode-runtime-scheme/docs/execution.md) now exercises the first
nested caller/callee recovery sequence with the existing stored authority.
Developer Scheme comes from the existing TS frontend; the caller is hand-authored
Scheme. Execution and explicit state live in the Scheme evaluator compiled by
Hoot. The proof covers normal completion, cancellation, suspended cleanup, and
repeated cancellation during cleanup in fresh Wasm instances.

This supports the working theory for a narrow trusted fixture. It does not
establish parity with yo-workflow's current language, macro support, complete
Effection scope semantics, hardened snapshot admission, or visualizer UI support.
No architectural requirement changes are proposed from this iteration.

## Iteration 2 evidence

The Hoot probe now separates logical scopes from function calls. Ordinary calls
inherit scope ownership; explicit scopes drain their own cleanup in reverse
registration order. Loop blocks retain distinct lexical environments, and closures
share mutable bindings by environment identity across capture and restore.

Six compiled patterns match native Effection effect traces and results on normal
completion. Their cancellation and repeated-cancellation paths match the JS
reference evaluator, with fresh Wasm restoration at every effect boundary. An
additional Scheme closure case verifies shared mutation and cleanup observation.
This does not establish concurrency, cleanup-failure, or try/finally parity. No
architectural requirement changes are proposed; snapshot format advances to v2
for explicit scopes and the persisted cancellation-requested flag.

## Iteration 3: explicit finally and thrown completions

The isolated Hoot evaluator now stores pending completions in explicit finally
frames, including return, throw, loop transfer, and cancellation. Nine fixture
patterns compare normal execution and rejected effects with native Effection;
cancellation is compared with the JS reference evaluator. All boundaries,
including terminal outcomes, survive fresh-instance capture/restore without
execution. Multiple failed ensures still drain; the last failure wins.

This supports the explicit-state theory. All four Hoot experiment suites and
the Scheme runtime package's 15 tests pass on Node 24.22.0 with no additional
flags, resolving the runtime blocker for the updated workspace Node version.
Earlier validation on Node 24.14.0 required `--experimental-wasm-exnref`.

Node 22 compatibility remains open: the expanded binary crashes Node 22.21.1
arm64's baseline Wasm compiler with an `is_int9(x)` assertion in
`PrepareTailCall`; `--no-liftoff` is only a diagnostic workaround. Retesting and
investigation are tracked in the
[Scheme runtime package TODO](../../packages/flowmode-runtime-scheme/docs/playground.md#node-compatibility-follow-up).
The binary MUST NOT be promoted into the application on this evidence alone.
Native cancellation parity, concurrent children, runtime-trap unwinding, and
whole-program tail-call behavior remain outside the proven subset.

## Iteration 4: independent Scheme emission

The developer frontend now returns Scheme and source metadata without compiling
reference bytecode. Hoot preparation and execution depend on the emitter and a
shared datum reader; they do not import the reference backends. A dependency
boundary test rejects those imports while running a compiled callee inside an
authored Scheme caller and restoring its state into a fresh Wasm instance.

The bytecode adapter remains a consumer for trace and unwind comparisons. This
separation changes no evaluator forms or snapshot formats and requires no Wasm
rebuild. General linking and application integration remain future work.

## Iteration 5: portable installed-effect values

The installed typed-effect probe now carries object inputs and outputs through
the existing registry and stored authority. Snapshot v3 uses explicit object and
null markers, with lists for arrays. The value bridge rejects unsupported host
values before resuming and preserves JSON distinctions and structured errors.
Exact rational transport avoids observed Hoot decimal-reader precision loss.
This proves finite-number transport, not full JavaScript arithmetic semantics.

The earlier source-identical capture and authority provenance requirements remain
in force. This is still a trusted experimental evaluator, not a general secure
snapshot loader. Production API discovery, host-resource provisioning, crash
during external delivery, and app registration remain separate work.

## Iteration 6: scoped recovery policy

Recovery selection now composes through `ProgramRecovery`, with full replay as
its default and checkpoint acceleration installed as scoped middleware at `min`.
Outer deployment policy and observation MAY override that choice. The existing
`ProgramPeer` and driver registry continue to own transport dispatch.

The mandatory `recoverProgram` envelope MUST validate the complete accepted
history and checkpoint anchor before dispatching policy. A supported checkpoint
selects suffix replay; unsupported formats delegate before acquiring compute.
A restoration error MUST NOT silently fall back to replay. Returned recovery
positions are checked and rejected attachments are released.

Production activation installs the accelerator from the selected driver's
continuation capability. Existing Effection drivers retain replay recovery.
Real Hoot tests prove snapshot/suffix and full replay reach the same frontier.

## Iteration 7: shared attachment, replaceable computation

`ProgramBackend` owns pinned manifest lookup and resource-owned computation.
`ProgramComputation.run` publishes boundaries through the shared attachment runtime;
`capture` captures computation state, and `dispose` releases compute without logical
cancellation. Effection generators use `createEffectionProgramBackend` and replay.
`flowmode-backend` adapts WorkflowKernel implementations, including Hoot.

`createWorkflowProgramDriver` accepts either an existing tool registry or an explicit
backend. Both use `openProgramAttachment` for command parsing, receipts, pending
operations, effect authorization, and emissions. The parallel kernel ProgramDriver
implementation is deleted. No routing or child execution is implemented in the
backend adapter.

The driver captures protocol identity, action index, and frontier digest around the
backend state. A restored backend MUST publish its saved boundary before advancing;
the shared runtime reconstructs fresh pending resolvers at that action index.
Checkpoints MUST NOT publish an unaccepted attempt or unrecorded cancellation.

The cross-backend proof routes a Hoot parent's invocation to an Effection child,
parks at the child's elicitation, replaces authority and backend instances, and
returns the child's result to the parent. Native generator emission support remains;
the current kernel boundary vocabulary still lacks emission events. Full Effection
concurrency and native cancellation parity inside Scheme remain outside this proof.
