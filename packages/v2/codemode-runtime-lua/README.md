# Portable Lua evaluator

createLuaEvaluator binds source, input, a Wasm module loader and request/result
wire decoders. Their return types infer the Guest request and result. It exposes
lazy acquisition and optional checkpoint capabilities using v2 public contracts;
there are no legacy framework runtime imports.

Each VM command creates a fresh bounded Wasm instance. Only the supplied loader's
compiled code may be cached. The Guest retains portable VM state between turns.
Capture detaches that state; restore uses the VM's restore command, including its
source/runtime identity checks, rather than replaying the program prefix. Close
discards retained state without evaluating authored cleanup. Authored failures
throw LuaFailure with their value, distinct from transport/decoder failures.

Commands/outputs have a 4 MiB budget and compute continuations have a fuel ceiling.
Synchronous Wasm instructions are not interrupted by native cancellation. Logical cancellation uses the pinned VM protocol described below. This slice does
not claim parity with the full v1 Lua kernel's inspection, tooling or authoring features.

## Pinned evaluator provenance

`generated/kernel.wasm` is copied unchanged from the existing v1 Piccolo artifact
at repository checkpoint 9306914993c98fdea6d3ad45d0a1b03dd65ed396. SHA-256:

    2d1062f4fffcba8a554331046953831e61a6a70ef3b19bd997b6d459cf732b81

The adjacent v1-manifest.json records its original build inputs. This original
artifact stays frozen for retained executions; checking it does not read the v1
checkout. V2 owns the current Rust sources, Piccolo patch and build scripts under
this package’s `vm/` and `scripts/` directories. Acceptance checks the original
artifact hash and loads both evaluators in-process. No subprocess, native executable,
legacy JavaScript adapter or network service is used.

The public luaWasmUrl points to packaged bytes. Hosts choose their own loader;
importing this package does not compile or instantiate the VM.

## Logical cancellation

Guest.cancel(reason) invokes the VM's cancellation command at a suspended boundary.
`workflow.scope(body, cleanup)` cleanup may yield further journaled exchanges. The
adapter exposes cleanup depth as a replay-stable protected ScopeBoundary, so cancelling
an already-pending cleanup preserves its reply authority. Repeated cancellation keeps
the current boundary and original reason. Cleanup failure becomes a cancelled Turn
with a failure diagnostic; ordinary authored failure remains LuaFailure.

```lua
return workflow.scope(function()
  return workflow.effect("lookup", { effect = "lookup", input = "topic" })
end, function(completion)
  workflow.effect("release", { effect = "release", input = "topic" })
end)
```

The VM unwinds through Lua's exception mechanism. Catching its cancellation signal
cannot produce successful terminal completion. Attempting another body exchange
after catching cancellation fails closed before request decoding; continue cancellation
through workflow.scope cleanup instead. The pinned VM does not expose general critical
regions. Cleanup is protected, but this is not full TypeScript logical-scope parity.

Evaluator checkpoints retain cancellation intent and suspended cleanup, and can restore
that exact boundary. The durable journal currently discards checkpoints on cancellation
and reconstructs cancellation plus accepted cleanup by replay; this change preserves
that recovery policy. Physical close discards state without running authored cleanup.
The existing synchronous computation budget and interruption limits still apply.

Acceptance covers cancellation during body or cleanup, repeated cancellation, cleanup
failure, direct checkpoint restoration, and a losing owned Lua race child across SQLite
reopen. A protected loser keeps its grant until cleanup answers; an unprotected loser
rejects stale answers. These are in-process journeys, not crash-safety evidence.
The VM bytes, provenance and checkpoint format are unchanged.

## Signup compensation and repair assembly

The [Lua signup workflow](../acceptance/__tests__/applications/signup-repair.lua)
and its [hosted acceptance journey](../acceptance/__tests__/applications/lua-signup-repair.acceptance.test.ts)
exercise saga-style compensation on the pinned VM, without adding critical-region
support. A TypeScript parent owns the Lua child through ordinary hosting; Lua authors
acquisition, approval, commitment and conditional cleanup. Repair decisions are
application-defined participant answers, not a new VM instruction or framework API.

The application supplies a stable, execution-specific resource key as pinned input.
The `workflow.scope` cleanup closure is established before acquisition starts. Local
flags distinguish an accepted resource/commit from an interrupted acquisition/commit;
replay reconstructs these flags from accepted replies. A known denied release yields a
protected repair request before cleanup returns. Operator-confirmed external repair
and explicit waiver carry distinct accepted evidence. Neither rewrites the failed
release, and the owned parent cannot settle while the repair request is pending.

This assembly intentionally uses a different commitment policy from the TypeScript
critical-region example. Lua body requests are unprotected: cancellation can revoke an
in-flight acquisition or commit even if the external service later succeeds. The late
reply cannot advance that revoked body boundary. Cleanup then parks a new repair
request naming the interrupted operation and stable resource key. An authorized
operator must supply evidence of a **final external outcome**, including assurance
that an old delivery cannot still change it. A transient “not found” lookup is not
sufficient to authorize compensation. Without that assurance, leave repair pending.

A confirmed committed signup skips compensation; confirmed noncommit allows release
of known acquired resources. Unknown acquisition requires confirmation of resource
presence or absence. These are new reconciliation decisions, not accepted results of
the revoked original calls and not authorization to retry them. The example's boolean
operator policy is a test input, not production authentication or proof of external
quiescence. All answers still validate the operation-specific decision and exact grant.

Uncertain **cleanup** delivery remains different: cleanup requests are protected, so
an unsettled release remains occupied and does not automatically create another repair
interaction. This example supplies no forced settlement or retry for such an attempt.

The journey covers normal success, known release refusal, repair/waiver, cancellation
racing late acquisition/commit replies, accepted replies lost to the owner before Lua
resumes, read-only reconstruction, duplicate/conflicting repair answers and occupied
cleanup. It uses both native runtimes, serialized local execution and SQLite reopen.
The VM bytes and checkpoint format are unchanged; the workflow uses journal replay,
not checkpoint restoration. This is not full critical-region parity, production saga
infrastructure, an external reconciliation protocol, or process-crash evidence.

## Declared effect bindings

Use `defineLuaEffectBindings` when Lua exchanges call declared framework effects:

```ts
const bindings = defineLuaEffectBindings({ lookup: lookupEffect });
const evaluator = createLuaEvaluator(runtime, {
  source,
  input,
  loadModule,
  decodeRequest: bindings.decodeRequest,
  decodeResult,
});
const grant = effects.grant({ lookup: lookupEffect });
// Host assembly uses grant.handle and installs grant.admission before routing.
```

```lua
local result = workflow.effect("lookup-site", { effect = "lookup", input = "topic" })
assert(result.ok)
return result.value
```

Bindings capture alias-to-definition IDs at declaration time. The decoder checks the
VM envelope and resolves only these aliases; names such as `toString` have no implicit
meaning. The request must include an `input` field. The VM site remains metadata;
existing journal positions and logical scope identify exchanges. Changing bindings
changes the program's replay contract, so pin them with the program identity.

Bindings do not install handlers or grant access. Hosting grants remain explicit,
including for declarations known to the decoder. Context and successful response
schemas run through ordinary effect delivery; accepted normalized Outcomes replay
without re-executing handlers or schemas. Failures remain authored Outcome data.
The evaluator's generic decodeRequest option remains available for other protocols.

Acceptance covers alias resolution through SQLite reopen, replay and checkpoints,
as well as rejected unknown/ungranted names, malformed envelopes and invalid schema
values on both runtimes. This is local assembly evidence, not remote authentication.

## Compile-only validation

`createLuaValidator(runtime, loadModule)` implements the portable CodeValidator.
Wrap it with `createCodeValidator(runtime, name, driver)` when scoped validation
policy is needed. It calls the same pinned VM's `validate` command, without
executing the source, acquiring a Guest or dispatching any capabilities. It checks
the 64KB UTF-8 source budget and syntax. Unknown language and source rejection
return diagnostics; module loading, Wasm traps and ABI failures throw. Native
cancellation cannot interrupt synchronous Wasm work. Each call discards its VM.

The VM's diagnostic text may refer to its internal prelude, so the adapter does
not claim authored source coordinates. Valid syntax can still call unknown tools,
fail schema validation, throw or exceed execution fuel. Validation is not a sandbox
or execution permission. Authoring guidance, grants and retained source identity
remain independent. See the codemode authoring acceptance journey for both runtimes.

## Kernel preparation

`createLuaKernel(runtime, { loadModule, decodeRequest, decodeResult })` implements
execution's generic Kernel. `yield* kernel.prepare(source, input)` returns the
existing LuaEvaluator with lazy `acquire` and required `checkpoints`. The earlier
`createLuaEvaluator(runtime, { source, input, ...options })` remains available as
the direct binding helper; it is the shared implementation, not a parallel engine.

Wrap the kernel with `createKernel(runtime.composition, name, driver)` for scoped
preparation middleware or driver selection. Each preparation has its own checkpoint
adapter; it will not capture another recipe's Guests. Restore can use detached
state with the matching source/runtime. The application must also verify bindings,
decoders, program identity and journal provenance. Neither prepare nor acquire
loads Wasm or advances Lua. The loader may cache code, never live Guests.

## Opt-in Piccolo libraries

`luaLibraryWasmUrl` selects the separately built library artifact. It exposes
Piccolo's `string.sub`, `string.char`, and `table.concat`, alongside the existing
base functions and workflow intrinsics. This is an explicit subset, not the full
Lua standard library. `luaWasmUrl` continues to select the original artifact.
The evaluator/kernel API and loader ownership are unchanged.

The native callbacks have stable checkpoint registration. The library VM uses a
new source/runtime identity, so checkpoints from the original VM are rejected
rather than reinterpreted. The checkpoint wire format remains unchanged. Hosts
must pin the chosen artifact in their program identity for journal replay too.

Piccolo's concat runs a native continuation. Its wrapper limits each call to
10,000 values and a conservative 1MiB output estimate (numbers reserve 512 bytes
per value). This bounds native work before the next checkpoint; instruction fuel
is not a wall-clock deadline. Existing 32MiB VM-memory and 4MiB wire limits still
apply. No IO, filesystem, network, module loading or coroutine library is exposed.

Build with `pnpm --filter @sweatpan.ts/codemode-runtime-lua wasm:build`; use
`wasm:verify` to compare a rebuild and `wasm:check` to verify source/artifact hashes.
The sibling `library-manifest.json` records v2-owned Rust sources, pinned Piccolo
patch, build scripts and artifact hash. Build and type checks verify these hashes
and the frozen legacy artifact. The toolchain uses its own
`.artifacts/v2-codemode-runtime-lua` cache and writes only this package’s generated
artifact. It neither reads nor changes the v1 package. The library build uses the
`standard-library` Cargo feature; it never replaces the retained original bytes.

Acceptance runs all three previously failing pair-generation programs, retains
native function references across checkpoint disposal/restore and cleanup, checks
cross-generation rejection and native concat budgets, and executes a new chat
turn through SQLite reopen. Both Effect and Effection are exercised.
