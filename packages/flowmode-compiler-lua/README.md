# flowmode-compiler-lua

Documentation-only scaffold. See the [ownership and promotion plan](../../docs/workspace/FLOWMODE.md).

Intended responsibility: translate the admitted shared Scheme intermediate
representation into ordinary Lua and assemble the Lua compiled artifact.

Current implementation: [lua-compiler](../../experiments/workflow-kernel/lua-compiler/README.md).
Reuse shared TypeScript admission and artifact metadata; do not add an independent
TypeScript frontend or another coroutine runtime.

Readiness evidence: admitted value semantics, lexical capture sharing, compiled
calls, suspension and ensure cleanup, and fresh-instance recovery with the Lua
runtime. Unsupported forms must fail compilation. Ordinary Lua language support
does not imply equivalent TypeScript compiler support.
