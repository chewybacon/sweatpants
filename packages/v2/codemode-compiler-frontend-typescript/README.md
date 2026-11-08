# TypeScript workflow frontend

The portable root exports `TypeScriptWorkflowInput` and
`TypeScriptWorkflowFrontend<Y>`. A frontend consumes authored TypeScript, an explicit
source-module graph and assembly-selected existing effect declarations. It admits
`use workflow` capabilities and produces the shared workflow Scheme S-expression
module defined by `codemode-compiler`.

ScriptC is an implementation detail, not a public input/output type. This package
now pins `@scriptc/compiler` to **0.3.6**. Its private `src/scriptc.ts` adapter lowers
already-admitted TypeScript and owns/disposes the tsgo frontend session. The
general source-admission-to-workflow implementation remains experimental. A bounded
public tool build path is described below. The earlier consumer in `experiments/workflow-kernel/scriptc-scheme` implements this contract:

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

Run them from the repository root on Node 24.22+. Normal package imports do not launch tsgo. Explicit compiler calls do, including
the authorized compiler acceptance exception described below.

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

## Public tool build and artifact cache

The Node-only `@sweatpan.ts/codemode-compiler-frontend-typescript/build` entry exports
`buildTypeScriptTool`. The root entry remains portable contracts; ScriptC types stay
private. Pass a public tool definition directly, its exported source, the selected
export name and an explicit declaration-module source graph:

```ts
const result = buildTypeScriptTool(
  {
    source: { language: "typescript", id: "send-email.ts", text: source },
    exportName: "sendEmail",
    modules: { "email-effects.ts": effectsSource },
    tool: sendEmail,
  },
  { cacheDirectory: ".artifacts/workflow-build" },
);

const module = result.artifact.module; // verified WorkflowModule; no ScriptC nodes
```

This admits the existing `defineTool(...).parameters(...).capabilities(...).elicits(...)
.execute(function* (...) { "use workflow"; ... })` builder. Compilation reads syntax
and selected declarations; it does not import source modules or execute the body.
The trusted build assembly supplies the corresponding tool contract and complete
declaration source graph. Declaration-module code is fingerprinted, not evaluated
or compiled; effects still run through separately installed host grants.

The first profile supports plain Zod string tool input, inferred string output,
plain `{ message: string } -> string` effects, immutable locals, string concatenation,
Outcome `ok`/`value` access, explicit if/else and yielding finally. Failure payloads
are opaque; branch on `ok` without inspecting `error`. It rejects transformed/refined
schemas, unknown calls, arbitrary member access, native operations, helper calls,
loops and unsupported source graphs. There is no `output(schema)` requirement and
no implicit unwrap. ScriptC checks the normalized typed body, including union-arm
narrowing. The regular repository type gate separately checks the real authored tool
fixture with public API inference; this build operation is not a whole-project tsc.

`WorkflowBuildArtifact` contains verified shared IR, provenance, a content key and
an integrity digest. The key covers source text/ID, selected export, all supplied
module text, selected schema/identity projections, the pinned ScriptC version, parser
version and the installed admission/projection/build/adapter implementation bytes.
Source and dist builds conservatively have different implementation fingerprints.
A cache hit checks provenance, digest and module structure before returning. A miss
owns ScriptC's subprocess/temp graph and atomically renames a completed JSON artifact
into the optional cache directory. Failure publishes nothing and never falls back to
an older key. Corrupt entries reject rather than being silently trusted.

The local cache is disposable trusted build storage, not an authenticated artifact
registry or runtime authority. Digest checks detect corruption, not a malicious cache
writer. Concurrent misses may compile twice; publication remains atomic. Builds are
synchronous and own no persistent process. Linked program identity is a separate
step binding the artifact's IR to caller source and evaluator identity.

`workflow-contract.acceptance.test.ts` now compiles its public authored tool through
this entry on an empty cache, then executes both fresh and cached artifacts in Scheme
and Lua alongside the native tool. It covers domain outcomes, detached VM restoration,
source/graph/contract invalidation, failed compilation recovery and corrupt cache
rejection. This is the explicit ScriptC subprocess exception to the usual simulated
acceptance rule; no installs, providers or real email are used by the tests.
