# Replaceable composition kernel

Status: working design on rr/composition-kernel. Not a released API.

## Objective

Keep Sweatpants' journal, host and effects system. Define a replaceable evaluator
behind ProgramDriver that can compose authored code, preserve explicit logical
execution state, and restore at an authority-verified frontier.

The JS explicit-state evaluator is the executable reference. The existing Hoot
Scheme runtime is a separate implementation, not already compatible with its
instructions or snapshots.

## Ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| Compiler frontend | Supported source semantics, diagnostics, code and source maps | Live execution or journal acceptance |
| Kernel | Calls, locals, closures, scopes, cleanup, effect suspension, opaque continuation | Effect execution, journal writes, human transport |
| ProgramDriver adapter | Pinned program lookup, command mapping, activation resources | Independent truth about accepted outcomes |
| Journal/host | Acceptance, replay verification, task ownership, external effects | Interpretation of kernel frames |

## Candidate kernel protocol

Each kernel declares a kind, implementation version, accepted program format and
snapshot format. Each program pins that identity. No snapshot interoperability
between implementations is implied.

- start(program, input): create execution and advance to the first boundary.
- resume(execution, outcome): apply one outcome to the pending effect.
- cancel(execution): request logical unwind; may produce cleanup effects.
- capture(execution): export an owned, portable snapshot at a supported boundary.
- restore(program, snapshot): reconstruct at the same boundary without executing
  the prefix or issuing effects.
- dispose(execution): release activation resources, without logical unwind.

The execution handle is opaque and activation-local. A boundary contains either
an effect request with a source address, a returned value, a thrown value, or
cancellation completion. Precise error and fuel-exhaustion algebra remains to be
decided before publishing the contract. No host functions or signals enter
snapshots.

The host wraps the kernel snapshot with program/input/task identity and an
accepted journal frontier. Kernel format validation and journal-frontier
validation are independent requirements.

## What is already proved

The imported tests exercise the real in-memory journal and ProgramDriver
protocol, ordinary replay, typed elicit descriptors, cleanup and cancellation.
Continuation caching avoids evaluator work during replay; it DOES NOT avoid
the host's journal-prefix scan. No database-backed native continuation
checkpoint has been integrated.

## First implementation increment

1. Extract evaluator mechanics from pull-adapter into a kernel implementation.
2. Keep elicit descriptor construction and schema validation at the adapter.
3. Make ProgramDriver consume that interface, with the existing JS kernel.
4. Run existing journal, pull and lifecycle proofs unchanged.
5. Add contract coverage for fresh-instance restore, incompatible kernel/program
   identity, disposed handles and cancellation while cleanup is suspended.

Do not claim multiple-kernel support based on injection of a second wrapper
around the same implementation.

## Next recovery increment

Add an authority-owned restoration path that verifies a checkpoint frontier,
restores the continuation, then processes only the accepted suffix. An accepted
reply before snapshot publication must recover correctly. Cache loss must fall
back to replay. Corruption policy must be explicit, not silently treated as
ordinary absence.

The current runtime fingerprint hashes adapters, registry code and evaluator
together. Separate kernel compatibility identity from deployment/bundle integrity
before treating the proposed kernel interface as independently replaceable.

## Composition and Wasm proof

Demonstrate a Scheme-authored caller entering a compiled TS callee, suspending
inside it, restoring BOTH callers, and returning into Scheme. Specify the common
executable representation before choosing a backend.

Then exercise a minimal Wasm kernel through the same contract. Wasm alone does
not serialize continuations; raw memory snapshots are not a requirement.

## Deliberately later

- Production application registration and deployment.
- Full operation coverage, remote transports and concurrent host fencing.
- Code/state migration across incompatible kernels.
- Scope-targeted deadlines, timeboxes and scheduler delivery.

Retain the movie-seat lifecycle requirements in questions/001-timebox-serializable-continuations.md.
