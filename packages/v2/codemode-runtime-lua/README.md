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

The adjacent v1-manifest.json records its original build inputs. Source/build
scripts remain in `packages/flowmode-runtime-lua/vm` and its `scripts` directory;
the v2 package does not yet own a rebuilt compiler toolchain. Acceptance checks
the artifact hash and loads it in-process. No subprocess, native executable,
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
