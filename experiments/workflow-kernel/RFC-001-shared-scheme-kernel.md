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

The [Hoot composition probe](hoot-composition/README.md) now exercises the first
nested caller/callee recovery sequence with the existing stored authority.
Developer Scheme comes from the existing TS frontend; the caller is hand-authored
Scheme. Execution and explicit state live in the Scheme evaluator compiled by
Hoot. The proof covers normal completion, cancellation, suspended cleanup, and
repeated cancellation during cleanup in fresh Wasm instances.

This supports the working theory for a narrow trusted fixture. It does not
establish parity with yo-tisyn's current language, macro support, complete
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
[Scheme runtime package TODO](../../packages/scheme-runtime/README.md#node-compatibility-follow-up).
The binary MUST NOT be promoted into the application on this evidence alone.
Native cancellation parity, concurrent children, runtime-trap unwinding, and
whole-program tail-call behavior remain outside the proven subset.
