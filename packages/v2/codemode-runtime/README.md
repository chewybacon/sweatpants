# Portable code evaluator contracts

`CodeSource`, `CodeDiagnostic`, `SourceLocation`, `CodeValidation` and
`CodeValidator` describe compile-only validation. `createCodeValidator` supplies
ordinary scoped operation middleware and driver selection. Validation never runs
authored code or dispatches effects. Infrastructure failures throw rather than
becoming source diagnostics. `checked` names the checks applied; successful syntax
validation does not establish runtime correctness, schema validity or permission.

Guest, GuestWork, Turn, CheckpointAdapter and ResolvedProgram are intentional type
re-exports from `@sweatpan.ts/execution`, where their implementation and ownership
remain. Acquisition, replay and checkpoint contracts are not duplicated here.
No concrete language adapter is loaded by importing this package.

Source locations are one-based when an adapter can accurately map them. Adapters
must not invent coordinates from diagnostics that refer to an injected prelude.
See [codemode](../codemode/README.md) for the package plan and acceptance evidence.

Kernel, PreparedProgram and ScopedProgram are also re-exported from execution,
with createKernel and createScopedKernel. The generic kernel lives in execution
because both scoped TypeScript callables and Lua source implement it. Language
validation remains separate. See [kernel ownership](../execution/README.md#generic-evaluator-kernels).
