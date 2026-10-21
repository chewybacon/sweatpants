# flowmode-compiler-scheme

`schemeWorkflowCompiler` implements the shared `WorkflowCompiler` contract for
developer TypeScript tools. It consumes the frontend and workflow Scheme
intermediate representation from `@sweatpants/flowmode-compiler`, emitting
`workflow-scheme-definitions-v1` artifacts. It does not build or execute Hoot Wasm.

Used by the Sweatpants Vite workflow integration and standalone artifact builds.
See [shared compiler documentation](../flowmode-compiler/README.md) for admission,
development behavior and validation. Hoot evaluator promotion remains separate.
