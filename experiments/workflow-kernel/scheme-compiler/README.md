# Workflow Scheme emission

`emitWorkflowScheme(source, options)` accepts developer TypeScript generator
source and returns `{ scheme, debug: { sites, locations } }`. Babel parses the
source; the frontend validates the supported subset and emits workflow Scheme.
It neither compiles bytecode nor executes the workflow.

`entryPoint` defaults to `"workflow"`; a named entry must exist in the source.
Set it to `null` to emit definitions only, for composition with an authored Scheme
caller. This avoids stripping a generated entry call from the output.

Options select the existing experimental capabilities: `allowEnsure`,
`allowFinally`, `allowScopes`, and `entryInput` (all default false). Scopes require
explicit unwind forms (`allowFinally`). These are emitter capabilities, not a
promise that every backend implements them. Unknown imports remain errors.

The Hoot composition fixture consumes this output directly. The evaluator is
compiled to Wasm separately, once per evaluator build; workflows are Scheme data
loaded into that evaluator. Source metadata stays alongside the Scheme for
inspection. This extraction does not add a general linker or a public package API.

`compiled-frames/compiler.mjs` is an optional reference adapter: it calls the
emitter, compiles its Scheme to reference bytecode, and derives reference frame
names. Existing parity tests use that backend to compare traces and unwinding.
The Hoot dependency-boundary test rejects imports of all reference backend
modules while running composition and fresh-instance restoration.

Run from the repository root:

```sh
node experiments/workflow-kernel/scheme-compiler/__tests__/emit.mjs
node experiments/workflow-kernel/hoot-composition/__tests__/no-bytecode.mjs
```

The second command requires the generated Hoot experiment artifacts; see the
[composition build instructions](../hoot-composition/README.md#run).

## Installed typed-effect bindings

The experiment accepts `installedEffects: [{ module, export, definition }]`, where
`definition` is an existing durable effect contract. A named import (including a
local alias) can then be used in `yield* ctx.effect(reference, input)`. Emission
records the contract name/version and source site; it does not import or execute
the host implementation. Unknown imports, unknown effect references, and shadowed
import bindings are rejected. The host supplies these bindings explicitly; SDK
installation discovery and general bundler symbol resolution are not implemented.

The Hoot installed-effect proof uses nested object payloads and results. The
frontend emits object construction, arrays, and null; the Hoot bridge preserves
those distinctions across effects and snapshots. See the composition value
contract for limits.
