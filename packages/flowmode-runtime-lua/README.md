# flowmode-runtime-lua

Documentation-only scaffold. See the [ownership and promotion plan](../../docs/workspace/FLOWMODE.md).

Intended responsibility: ordinary Lua evaluation, bounded JSON exchanges, portable
VM state, and Node/worker Wasm adapters with reproducible build inputs.

Current implementation: [teal-lua-checkpoint](../../experiments/workflow-kernel/teal-lua-checkpoint/README.md).
Despite that experimental directory name, the supported language is ordinary Lua.
The Playground's LuaEvaluationPort currently lives in the app; promotion must
decide its ownership and typed command boundary alongside the runtime adapters.

Readiness evidence: pinned Piccolo patch/build, value and capture limits, shared
cell preservation, cancellation and yielding cleanup, fresh-instance restore,
and migration of Playground and Execution consumers. Distinguish Playground
replay recovery from Execution's authority-backed continuation checkpoints.

The separate scoped-handoffs scheduler is not part of the ordinary runtime yet.
Its existence does not establish spawn/race or durable timer support here.
