# flowmode-compiler-lua

`luaWorkflowCompiler` implements the shared `WorkflowCompiler` contract for
developer TypeScript tools. It lowers the shared typed Scheme IR into `piccolo-lua-module-1` artifacts. It does not execute Lua or
implement checkpoint storage.

Used by the Sweatpants Vite workflow integration and standalone artifact builds.
See [shared compiler documentation](../flowmode-compiler/README.md) for supported
syntax, development behavior and validation. Lua evaluator and scheduler promotion
remain separate.
