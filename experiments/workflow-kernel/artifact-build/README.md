# Build once, recover without compiling

Experimental proof for developer-authored `"use workflow"` generators.

## Run

Use Node 22 with the workspace dependencies and SDK build installed:

```sh
node experiments/workflow-kernel/artifact-build/test.mjs
node experiments/workflow-kernel/compiled-finally/cleanup-errors-test.mjs
```

## Boundary

1. **Build:** TypeScript checks the developer module; the trusted build process
   evaluates its tool definition and extracts its actual SDK contracts.
   The constrained generator frontend compiles the program.
2. **Package:** JSON contains compiled instructions, source locations, source text
   for inspection, schema descriptors, portable validator recipes and identities.
3. **Load:** The runtime checks bundle integrity, exact runtime identity and artifact
   identity, reconstructs supported validators, then loads the compiled program.
4. **Run:** Journal input and effect results drive explicit frames, environments,
   scopes and cleanup registrations. A checkpoint can restore these structures;
   the journal remains a fallback when a checkpoint is unavailable.

The artifact identity includes the runtime and validator recipe identity.
Changing them requires a new artifact; no automatic migration is implied.

The runtime is the experimental JavaScript evaluator, not Hoot or a Wasm heap
snapshot. Runtime dependencies are still workspace files; this is not yet a
standalone published package. Hashes pin identity and detect corruption; they do
not establish publisher trust.

## What the executable proof covers

- Build in a separate process, delete the input source file.
- Block compiler frontend imports and the build's module-evaluation mechanism.
- Restore every acquire/release boundary in fresh processes.
- Three loop iterations with independent captured hold IDs.
- Identical results from checkpoints and journal replay.
- Cancellation during suspended cleanup, without another acquisition.
- Cleanup failure propagation and completed-record idempotency.
- Reject changed bundle contents and changed validator recipes.
- Compare supported reconstructed validators against their original Zod schemas.
- Reject custom refinements, transforms, coercion and non-strict object schemas.
- Separately compare multiple failing cleanups against native Effection.

Source text inside the bundle is debug data. The tripwire also has a negative
control that deliberately imports the compiler and must fail.

## Deliberate limits

Portable validators support strict objects, strings/numbers with bounded common
checks, booleans, null, literals/enums, arrays, unions, optional and nullable.
They do not serialize arbitrary JavaScript callbacks. Zod version and runtime
implementation are pinned. This experimental codec uses Zod internals and needs
explicit revalidation on upgrades.

No deadline scheduler, targeted scope cancellation, migration, concurrency,
deployment integration or authorization protocol is provided here. Preserve
those future requirements in the question file; prove the sequential core first.

## Existing SDK pull integration

`pull-adapter.mjs` provides:

- `createPullMachine(bundle, input, snapshot?)`: explicit frontier/resume/capture,
  with typed replies, input/output validation and input/artifact-bound checkpoints.
- `createCompiledPullProgram(bundle)`: the existing
  `DurableTool.program(input, context)` signature, delegating to `context.pull`.
- `createCompiledPullTool(bundle)`: the existing generated pinned-program
  constructor and artifact identity verification.

`pull-test.mjs` compares the full request descriptors (including portable response
schema and interaction binding) and outcomes against the actual SDK-authored
generator. Fresh-process tests discard and restore at every pull, including
release during cleanup, with compiler imports blocked.

This adapter writes no journal. Its checkpoints must be fenced to an accepted
authority cursor by the integrating host. The standalone machine checksum is
neither a journal receipt nor an authentication mechanism.

The first bridge supports message-only elicitation requests and the spike's
string error contract. Context/documents, samples, host error serialization and
logical cancellation routing need subsequent increments. Halting the wrapper
does not implement logical workflow cancellation. Do not register this bridge
as a production replacement before that lifecycle is wired and tested.

Run the integration proof:

```sh
node experiments/workflow-kernel/artifact-build/pull-test.mjs
```

## Real journal / ProgramDriver proof

`program-driver.mjs` implements the sequential elicitation slice of the real
ProgramDriver protocol. `authority-test.mjs` runs it through the workspace's
real in-memory journal and workflow driver harness, replacing the authority shell
and evaluator driver between activations. This is not a fake journal.

- Start/resume action indices stay ordered.
- Accepted resolution receipts bind session, task, pull, offset and outcome digest.
- Disposable continuation-cache keys include the prior accepted prefix, pinned
  program/input identity and receipt. Journal replay still checks every descriptor
  and chain entry before live advancement.
- Cache hits avoid evaluator work; cache loss falls back to ordinary evaluation.
  This is not yet a journal-native continuation checkpoint or a replay-scan bypass.
- Shutdown drops the runtime handle without stepping or unwinding the logical VM.
- An explicit cancel command or journaled cancelled outcome drives logical unwind.
  Cleanup can yield another pull and finish on a later activation.
- Live cancellation disables further cache writes on that activation: its effect
  is not yet represented in the accepted receipt prefix.

The driver advertises replay capability only. Cache data is trusted, disposable
host storage, with checksums for corruption detection; receipts are supplied by the
trusted journal/host path, not authenticated by this adapter in isolation.
No direct public endpoint should accept these commands.

`authority-test.mjs` covers completion with and without cache, cancellation before
acquisition, and cancellation during suspended release. `driver-test.mjs` covers
shutdown reasons, stale/rejected/mismatched receipts, ordered resumes and cache
isolation after live cancellation.

```sh
node experiments/workflow-kernel/artifact-build/authority-test.mjs
node experiments/workflow-kernel/artifact-build/driver-test.mjs
```

Still unproven: database-backed cache storage, concurrent host fencing at a remote
transport, the full ProgramDriver operation set, structured error preservation,
scope-targeted cancellation and deadline delivery. No application registration
or deployment is changed by this spike.
