# flowmode-compiler

Shared developer TypeScript workflow admission, static SDK declaration analysis,
typed Scheme IR, diagnostics, dependency discovery and portable
artifact tooling. Consumed by the Scheme and Lua targets and the Sweatpants Vite
plugin. This package does not execute workflows or own journal persistence.

Most applications use `frameworkPlugin()` from `@sweatpants/vite-plugin` and put
`"use workflow"` in an exported `createDurableTool(...).execute` generator. They
import and register the ordinary SDK tool. Vite attaches both compiled language
artifacts; framework consumers select one with `getCompiledWorkflow(tool, language)`
from `@sweatpants/flowmode-runtime`. `workflowPlugin()` is also available separately
when applications compose Vite plugins explicitly.

Direct consumers can import `analyzeWorkflowTools`,
`createTypeScriptWorkflowCompiler`, `prepareWorkflow`, `emitPreparedWorkflow`,
`emitSchemeIR`, `workflowSourceDependencies` and `compileWorkflowModule`. Targets
receive verified typed IR and return payload plus debug metadata. Vite prepares
and checks each workflow once, then emits both targets from that same program. The existing
`WorkflowCompiler` protocol and portable artifact/binding contracts remain in
`flowmode-runtime`: language authoring stacks also implement that protocol without
using this TypeScript frontend. No duplicate compiler or artifact interfaces exist.

The `scheme-data/read` and `scheme-data/values` subpaths contain pure datum
serialization helpers. Evaluators can consume those without loading Babel,
TypeScript or the frontend.

## Shared Scheme intermediate representation

`TypeScript → typed Scheme forms → Scheme text or Lua lowering`.

`scheme-ir.ts` models the existing executable workflow Scheme dialect. The
frontend lowers JS addition to `js-add`, strict comparison to `=`/`not`, JS
conditions to explicit `truthy` calls, and host exchanges to `yield-at` with a
`list` request. Closures, definitions, mutation and cleanup use `lambda`, `define`,
`set!` and `ensure`. There is no separate generic workflow IR or TypeScript-to-Lua
path. Scheme serialization does not decide source-language coercions.

IDs, value types, callable kinds, captures, source positions and cleanup ownership
annotate these forms. They are checked before serialization/lowering and are not
additional runtime Scheme syntax. `apply` represents ordinary Scheme application;
`tail-value` represents an implicit final value in the restricted experimental
frontend. SDK workflows use explicit `workflow-return` forms. The existing linker
still registers serialized definitions with the model-authored caller and loads
the resulting program into the kernel.

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
imports and named imports of local TypeScript helper functions are supported and
watched transitively. Aliases resolve through the same TypeScript Program and
TypeChecker that check the author source. Helpers can be synchronous or delegated
generators; imported generators do not need a `use workflow` directive. Their
bodies must obey the same subset as local functions. Primitive parameter aliases
are resolved by the checker; structural types, unions and generics retain source
checking and use the IR's JSON representation. Runtime schemas remain authoritative
at exchange boundaries.

Helper modules admit function declarations, interfaces, type aliases, and named
imports. Module initialization, module-level values (including `const` objects),
side-effect imports, re-export barrels, defaults, namespaces, runtime import cycles,
dynamic imports and arbitrary package runtime imports are rejected. Package inputs
follow the workspace dependency build. Resolution uses NodeNext; Vite rejects a
runtime import if its resolver selects a different file. Aliases/export conditions
that disagree with this resolution policy are not silently accepted.

All helper bodies are validated before unreachable functions are removed. Imported
functions are included once per source symbol; calls remain calls, not substituted
bodies. Captured mutable locals share cell identity. `ensure` in a delegated helper
registers on the caller's active scope, not on a new function-return boundary.
Cleanup registration during cleanup and nested registration in branches remain
outside the Lua subset. Helpers cannot introduce undeclared host bindings.

The IR uses distinct function/value/cell/scope/loop IDs, explicit captures, callable
kinds, structured regions and targeted exits. Its verifier checks reference scope,
capture identity, call/delegation kinds and arity, basic value compatibility, cleanup
ownership and exit targets. It is transient compiler state, not a persisted runtime
format. The Scheme backend serializes these forms; the Lua backend lowers the same
forms and materializes operands in source order. Source positions retain the original helper filename. The artifact source
field remains the entry source, with helper origins in debug metadata.

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
transitive source/type dependency invalidation. `pnpm -C apps/yo-workflow execution:test`
exercises the real evaluators, cleanup, restore and changed-build rejection.

The compiler sources and tests are strict TypeScript. `tsc -b` emits JavaScript,
declarations and source maps to `dist`; package exports and standalone Node
experiments consume that build. The Scheme datum codec remains a separate pure
subpath with no compiler dependency at runtime.
