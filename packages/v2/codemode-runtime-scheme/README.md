# Scheme Execution adapter

`createSchemeKernel(runtime, options)` prepares a `SchemeEvaluator`; the evaluator
acquires independent v2 Guests and provides checkpoint capture/restore. Preparation
and acquisition are lazy. Each start/restore loads a fresh machine, owned by that
Guest until physical close. A machine arriving after acquisition cancellation is
closed without executing source. Close never runs authored cleanup.

The trusted `loadMachine` protocol implements start/resume/reject/cancel/capture/
restore/close and returns logical scope metadata for every effect. This package
contains no legacy SDK, compiler, model or storage dependency. The portable root
entry does not import Node or instantiate Wasm. The
host supplies request/result decoders; v2 recovery and hosting retain advancement,
acceptance, participant answers and cancellation authority.

The loader must use the Scheme **Execution** evaluator, not the separately defined
Playground evaluator. It owns codecs, bounded execution, artifact verification and
truthful body/cleanup scope reporting. Returning incorrect scope metadata changes
which pending requests cancellation can revoke. This is a trusted adapter boundary,
not metadata supplied by authored Scheme. The v2 Node loader supplies this protocol
using v2-owned Hoot assets and codecs. Worker bridge assets are packaged, but a
public Worker loader and broader scope projection remain separate work.

`identity` pins the evaluator artifact and loader protocol. Checkpoints retain that
identity, exact source, opaque machine state and the original cancellation reason.
Restore rejects mismatched source/identity before loading; the machine validates its
opaque state. Checkpoints are trusted persistence, not authenticated client input.
The application's program resolver must separately pin inputs, bindings and decoder
semantics for replay. Changing input while restoring is not supported.

An authored thrown result becomes `SchemeFailure` only after the evaluator finishes
cleanup. During cancellation it becomes a cancelled Turn with failure information.
Decoder/loader/trap failures remain errors, not fabricated terminal results. Catching
an error does not establish that cleanup completed. Native Wasm calls are synchronous;
fuel is not a wall-clock cancellation guarantee.

## Consumer evidence

`scheme-workflow.acceptance.test.ts` compiles the actual yo-workflow
`review-draft.workflow.ts` through the existing TypeScript frontend and Scheme target.
A transitional JavaScript fixture isolates those legacy build dependencies from v2's
production declaration compilation. It uses the v2 Node loader and calls the compiled
definition directly. The loader projects the pinned evaluator's `cleaning?` rule
from live validated state for this root-scope journey. The fixture no longer imports
the v1 Scheme runtime, and does not run a legacy host.

On Effect and Effection, the journey parks for approval, accepts a typed reply,
reopens SQLite, restores a checkpoint at cleanup, answers cleanup and completes.
Further checks cover cancellation in body/cleanup, repeated cancellation, physical
close, detached restore, source mismatch, rejected approval draining cleanup, and
cancellation while the real machine loads. Observation of a completed journal does
not acquire or restore another Guest. Node >=24.22 is required: Node 22's V8 can
crash while compiling this Hoot artifact's tail calls.

This slice does not promote the compiler/linker contracts, change the `use workflow`
syntax, integrate Vite, expose inspection APIs, or add Scheme to the live chat app.
The v1 runtime and compiler are unchanged. V2 now owns its Execution evaluator,
Hoot toolchain configuration, metering pass, reflection assets, datum codecs and Node
loader. Only the compiler/declaration fixture remains a v1 dependency. Broader
nested-scope and critical-region semantics require their own consumer evidence.

## Node loader and owned build

```ts
import { createSchemeKernel } from "@sweatpan.ts/codemode-runtime-scheme";
import {
  loadSchemeMachine,
  schemeRuntimeIdentity,
} from "@sweatpan.ts/codemode-runtime-scheme/node";

const kernel = createSchemeKernel(runtime, {
  identity: schemeRuntimeIdentity,
  loadMachine: loadSchemeMachine,
  decodeRequest,
  decodeResult,
});
```

`loadSchemeMachine` verifies the packaged source/build/loader and artifact hashes
before loading. Its identity derives from that manifest; a changed adapter is not
silently treated as the same checkpoint runtime. Sources and build scripts are
included in package files so verification also works from emitted declarations/code.
Node versions below 24.22 fail explicitly before entering the affected V8 compiler.

Use `pnpm --filter @sweatpan.ts/codemode-runtime-scheme wasm:build` to build with the
pinned Docker/Hoot toolchain. `wasm:verify` rebuilds into a temporary directory and
compares all artifacts without replacing them. `wasm:check` verifies inputs and
assets without Docker, and runs as part of package build/type checking. The build
stages the Execution kernel and reflection helpers together before publication.
It reads and writes only this v2 package; it does not compile Playground or depend
on a previously built v1 image/artifact directory. The Worker bridge is generated
from the same reflection source, but Node acceptance does not establish Worker
bundling or deployment support.
