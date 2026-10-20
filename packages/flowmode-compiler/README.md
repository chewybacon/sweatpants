# flowmode-compiler

Shared developer TypeScript workflow admission, static SDK declaration analysis,
Scheme intermediate representation, diagnostics, dependency discovery and portable
artifact tooling. Consumed by the Scheme and Lua targets and the Sweatpants Vite
plugin. This package does not execute workflows or own journal persistence.

Most applications use `frameworkPlugin()` from `@sweatpants/vite-plugin` and put
`"use workflow"` in an exported `createDurableTool(...).execute` generator. They
import and register the ordinary SDK tool. Vite attaches both compiled language
artifacts; framework consumers select one with `getCompiledWorkflow(tool, language)`
from `@sweatpants/flowmode-runtime`. `workflowPlugin()` is also available separately
when applications compose Vite plugins explicitly.

Direct consumers can import `analyzeWorkflowTools`,
`createTypeScriptWorkflowCompiler`, `emitTypeScriptWorkflowScheme`,
`workflowSourceDependencies` and `compileWorkflowModule`. Targets receive the
shared admitted source and return payload plus debug metadata. The existing
`WorkflowCompiler` protocol and portable artifact/binding contracts remain in
`flowmode-runtime`: language authoring stacks also implement that protocol without
using this TypeScript frontend. No duplicate compiler or artifact interfaces exist.

The `scheme-data/read` and `scheme-data/values` subpaths contain pure datum
serialization helpers. Evaluators can consume those without loading Babel,
TypeScript or the frontend.

## Supported authoring

One exported tool per module, with a named generator or an inline generator
passed to `.execute`. The generator takes `(input, ctx)`. Declarations must be
static. The automatic frontend admits literal `createDurableTool` builder chains
and `z.object`, `z.string`, `z.boolean`, `z.number`, `z.null`, `z.enum`, `z.array`
and `z.literal` schemas. Schema projections are explicitly marked projections;
the SDK owns parsing. Elicitation exchanges retain the existing permissive JSON
binding descriptors and host validation, rather than claiming inferred runtime
schema equivalence.

The portable subset supports local values, branches, ordinary calls and closures,
message-only elicitation and top-level yielding `ensure` cleanup. The Lua target
rejects unsupported control forms such as loops and try/finally. Both targets must
admit a tool for automatic compilation to succeed. Unknown imports, ambient host
calls, dynamic declarations and unsupported schemas fail compilation. Local type
imports are supported and watched transitively; importing arbitrary runtime
helpers is not supported. Package inputs follow the workspace dependency build.

The frontend never evaluates author modules. Compilation returns diagnostics;
Vite reports errors with source locations. The normal SDK module and the portable
compiled artifact remain distinct representations.

## Development and builds

Vite compiles imported tool modules, recompiles on source/type dependency changes,
and uses the same transform for production. There is no persistent artifact cache
to fall back to after failed compilation. Normal Vite invalidation/reload applies;
migrating an already suspended workflow to new code is not supported.

Execution pins the compiled program digest in persisted runs. Loading a run with a
different build fails explicitly with `workflow_source_changed`; the user starts a
new run. Unchanged builds retain fresh-instance recovery.

Run package tests and `pnpm -C packages/vite-plugin test` for static admission,
target output, production emission, real file watching, failure/recovery and
transitive type dependency invalidation. `pnpm -C apps/yo-workflow execution:test`
exercises the real evaluators, cleanup, restore and changed-build rejection.
