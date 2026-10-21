# Piccolo VM contract

The pinned Piccolo checkpoint patch serializes the reachable VM graph, including
Lua threads, frames, shared cells and open upvalues. Host handles never enter the
serialized state. Each command creates fresh compute and restores only portable
state. Snapshots must come from trusted persistence; this is not a security
sandbox for arbitrary checkpoint bytes.

The Wasm linker caps memory at 64 MiB. The host ABI bounds JSON commands and
responses to 4 MiB. Fuel bounds each evaluation slice; cumulative fuel is retained
across restoration. Cancelling compute unwinds cleanup and may suspend at another
host exchange. Repeated cancellation cannot abandon pending cleanup.

`src/__tests__/fuel.mts` pins sliced computation, shared captures and cancellation.
`src/__tests__/tail-call.mts` pins effect continuations with no remaining Lua frames.
The separate scoped-handoffs experiment shares the patched VM codec but its
scheduler is not an ordinary Lua runtime capability.

See the package README for build, manifest verification and public entry points.
