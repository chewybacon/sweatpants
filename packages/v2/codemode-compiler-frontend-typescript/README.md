# TypeScript workflow frontend

This scaffold exports `TypeScriptWorkflowInput` and
`TypeScriptWorkflowFrontend<Y>`. A frontend consumes authored TypeScript, an explicit
source-module graph and assembly-selected existing effect declarations. It admits
`use workflow` capabilities and produces the shared workflow Scheme S-expression
module defined by `codemode-compiler`.

ScriptC is an implementation detail, not a public input/output type. This package
now pins `@scriptc/compiler` to **0.3.6**. Its private `src/scriptc.ts` adapter lowers
already-admitted TypeScript and owns/disposes the tsgo frontend session. The
complete source-admission-to-workflow implementation remains experimental. The
consumer in `experiments/workflow-kernel/scriptc-scheme` implements this contract:

1. Admit supported directive/capability calls using actual lexical bindings.
2. Normalize them to explicit exchanges before generic generator lowering.
3. Use pinned ScriptC IR for ordinary language bindings, captures and helper calls.
4. Project through the existing verified Scheme emitter to S-expressions and
   admitted effect/source metadata.

`Operation` in authored source is a type, not a request to compile Effection.
The experiment supports one entry, string replies and one admitted pure helper;
it is not a general TypeScript compiler or module loader. Its acceptance adapter
uses recorded IR with source hashes, refusing changed input until extraction runs
again. Manual extraction disposes its tsgo connection. No process or dependency is
silently installed when this package is imported.

Targets consume only WorkflowModule. They cannot depend on authored TypeScript,
ScriptC representation, or this package. Host schema validation and authority
remain with the existing tool/hosting assembly.

## Dependency and upgrade policy

The root pnpm patch `patches/@scriptc__compiler@0.3.6.patch` adds only two package
exports: `frontend/pipeline` and `frontend/program-node`. It changes no compiler
implementation. These upstream internal interfaces are intentionally contained in
`src/scriptc.ts`, which is not exported through the portable package root.
No runtime/source filesystem escape around Node's package exports is used.

The lockfile pins the published tarball and patch hash. The source-research commit
is historical provenance, not a claim that every file in the npm release matches
that revision. Both existing probe IR hashes reproduced exactly with npm 0.3.6.

`ignoredOptionalDependencies` excludes only ScriptC's optional LLVM/native runtime
platform bundles. The frontend still uses its required TypeScript/tsgo dependency
and ScriptC runtime declarations. No install lifecycle script is required. This
selection supports frontend lowering only; it deliberately does not support the
package's full native/linking CLI.

To upgrade: inspect the patched interfaces and lifetime contract, change the exact
version and patch together, rerun both manual extraction commands, review any IR
changes, then run the normal acceptance and landing gates. Do not silently update
a recorded fixture merely to satisfy its hashes. A supported upstream frontend
export would let us remove the export patch without changing our public contract.

The extraction commands now use this package's installed adapter, with no path to
an external source checkout:

```sh
node --conditions=development --import tsx experiments/workflow-kernel/scriptc-scheme/extract.mjs
node --conditions=development --import tsx experiments/workflow-kernel/scriptc-scheme/extract-workflow.mjs
```

Run them from the repository root on Node 24.22+. Normal package imports and the
acceptance suite do not launch tsgo; only explicitly invoking the adapter does.

## Live source-graph compilation

The private adapter now also provides `lowerScriptcSources`: a supplied, already
admitted source graph is written to an owned temporary directory, lowered with
ScriptC, and returned with relative source IDs. It rejects absolute/traversing
source IDs, rewrites only location fields (never authored string values), and
removes scratch files on success or failure. `lowerScriptcModule` closes tsgo.
This synchronous build-time operation is not interruptible through Runtime while
it is running; no interactive compilation scheduling policy has been introduced.

`experiments/workflow-kernel/scriptc-scheme/live.mjs` is the first live implementation
of `TypeScriptWorkflowFrontend`. It shares macro admission and projection with the
recorded acceptance adapter but reads no recorded IR/provenance. Its manual runner
compiles original and edited sources, emits Scheme and exercises restore/cleanup
on both host runtimes. It still supports only the experiment's bounded source and
helper shape; this is not a promoted general TypeScript frontend.
