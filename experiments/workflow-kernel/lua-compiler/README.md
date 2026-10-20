# TypeScript → Lua workflow compiler spike

The existing `review-draft.workflow.ts` now compiles to either Scheme or Lua.
`luaWorkflowCompiler` implements the existing `WorkflowCompiler` contract and
returns the existing `CompiledWorkflow` envelope. The normal DurableTool export
is unchanged. This spike does not switch yo-workflow's production composition or
its current handwritten Lua demo definition.

The shared `createTypeScriptWorkflowCompiler` in `tsdown-authoring/plugin.mjs`
owns static SDK builder extraction, declared export checks, TypeScript checking,
exchange admission, and artifact metadata. Its target supplies a definition
format and an emitter. Both targets now call `emitTypeScriptWorkflowScheme`: the
existing Scheme output is the shared intermediate. Hoot consumes it directly;
`scheme-to-lua.mjs` reads its forms and translates the supported subset to Lua.
The independent TypeScript-to-Lua lowering has been deleted. The intermediate
retains Scheme's `(ctx, input)` convention; the Lua artifact exposes `(input)`.
No public kernel/Flow/driver types or snapshot formats changed.

The target lowers `yield* ctx.elicit(...)` to `workflow.effect(...)` and a
top-level `yield* ensure(function* () { ... })` to `workflow.scope(body, cleanup)`.
Piccolo's existing scope continuation handles yielding cleanup and preserves
pending completion. Compiler output never introduces another coroutine runtime
or a host generator that must survive capture.

## Bounded language

Supported: one named directive-bearing SDK execute generator; initialized local
bindings and assignment to mutable locals; scalar literals; property reads; strict equality/inequality; boolean
negation; block-bodied if/else; value returns; throws; message-only elicit calls;
addition/subtraction and ordered comparisons; anonymous synchronous and generator closures,
returned closures and ordinary calls; and top-level ensure callbacks with yielding cleanup. Lua conditionals explicitly
implement JavaScript truthiness for portable JSON values (including zero and the
empty string). String literals encode UTF-8 using Lua escapes. Names are prefixed
to avoid collisions with Lua keywords; bindings receive unique generated names.

Unsupported constructs fail compilation: loops, try/catch/finally, ambient host calls,
arbitrary imports, named nested function declarations, multiple exports,
conditional/nested ensure registration, return from cleanup, and cleanup captures
of variables declared after registration. A function path that falls through
without a JSON return fails explicitly at runtime. This is not general
TypeScript-to-Lua equivalence or full Scheme compiler feature parity.

The VM is unchanged. Captures still contain guest continuation state; the shared
driver and journal own protocol position and accepted effects. Runtime boundary
schemas remain host declarations; static TypeScript types do not replace them.

## Run

Build the workspace dependencies and Lua Wasm using the existing tools:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -b
pnpm --filter @sweatpants/flowmode-backend... --workspace-concurrency=1 run build
pnpm -C apps/yo-workflow execution:lua:build
node --import tsx --test experiments/workflow-kernel/lua-compiler/__tests__/*.mjs
```

The tests compile the actual SDK source, link a Lua caller, run real Piccolo Wasm,
capture at approval, destroy the kernel, restore, reach cleanup, capture/restore
again, and complete. They cover approval, decline, host rejection, cancellation,
repeated cancellation, cleanup failure, captured Unicode strings, JavaScript
empty-string truthiness, TypeScript diagnostics, and unsupported syntax. The
original Scheme compiler/transform tests retain their existing expectations.

The runtime tests also prove returned closures and shared mutable capture cells
through nested compiled calls, restored approval and cleanup, rejection and
repeated cancellation in both kernels.

The runtime test also executes the same captured-cleanup scenario in fresh Hoot
Wasm instances. A compiler test asserts that the Lua artifact is exactly the
translation of the Scheme artifact and that source metadata is identical.

The runtime test writes review-draft.lua and program.json under
`.artifacts/lua-compiler/` for inspection. These are separate compiled data, not a
replacement for the SDK tool module. Kernel tests do not certify live-provider,
Cloudflare deployment, or journal delivery behavior.

## Research and reuse decision (2026-10-19)

### Tisyn

Inspected [taras/tisyn at 4e645b5](https://github.com/taras/tisyn/tree/4e645b54701211347e1a1ce38235ca32a6c5d86e).
Its [compiler](https://github.com/taras/tisyn/blob/4e645b54701211347e1a1ce38235ca32a6c5d86e/packages/compiler/src/compile.ts)
parses TypeScript generator functions, discovers contracts, emits explicit IR,
and validates it. The rooted graph pipeline resolves reachable modules/helpers.
Its [IR builders](https://github.com/taras/tisyn/blob/4e645b54701211347e1a1ce38235ca32a6c5d86e/packages/compiler/src/ir-builders.ts)
distinguish Call, ExternalEval, ScopeEval, Try, SpawnEval and ResourceEval. This
matches the important distinction between interpretable work and opaque exchange.

Useful ideas: bind names before emission; separate static import resolution from
execution; represent workflow control semantics explicitly; share admission and
source metadata across targets. Its compiler emits Tisyn IR, not Lua. Direct
adoption would require our SDK authoring adapter plus an IR-to-target translation
and a semantic audit of scope, cleanup, cancellation, and capabilities.

The compiler's [package.json](https://github.com/taras/tisyn/blob/4e645b54701211347e1a1ce38235ca32a6c5d86e/packages/compiler/package.json)
declares `UNLICENSED`. No Tisyn implementation was copied and no dependency was
added. Reuse needs licensing clarification as well as technical evaluation.

### TypeScriptToLua

Inspected [TypeScriptToLua at 0c3a141](https://github.com/TypeScriptToLua/TypeScriptToLua/tree/0c3a141280d6796c1a1906210622bda8ea4180a2),
MIT-licensed. It has a real Lua AST, printer, type-aware transforms, and a
[visitor plugin interface](https://github.com/TypeScriptToLua/TypeScriptToLua/blob/0c3a141280d6796c1a1906210622bda8ea4180a2/src/transpilation/plugins.ts).
This is the strongest candidate to revisit if ordinary expression/type lowering
becomes the dominant maintenance cost.

Its default [generator runtime](https://github.com/TypeScriptToLua/TypeScriptToLua/blob/0c3a141280d6796c1a1906210622bda8ea4180a2/src/lualib/Generator.ts)
uses coroutine.create/resume/status and Symbol.iterator. Our guest exposes only
selected base functions and managed workflow operations, and checkpoints do not
promise arbitrary extra coroutine support. Default generator lowering therefore
does not fit. A plugin could replace workflow function/yield/cleanup lowering,
but would still need a strict audit of emitted library helpers and allowed Lua
features. This incompatibility was established by source inspection, not a claim
that every possible custom TSTL backend is incompatible.

### Other projects inspected

- [roblox-ts at 68648b0](https://github.com/roblox-ts/roblox-ts/tree/68648b0c633ef1016009aec7521b528f648ba656):
  MIT, TypeScript → Luau for Roblox. Useful compiler separation and language
  semantics work, but its target/runtime differs from our regular Lua/Piccolo VM.
- [wowts/tstolua at 858c57c](https://github.com/wowts/tstolua/tree/858c57c0ecfc8eb766882d5928609160a9f6a4dc):
  MIT, a TypeScript subset targeting Lua 5.1 World of Warcraft addons. Its stated
  domain is ordinary addon translation, not checkpointed workflow control.
- [ASDAlexander77/TypeScriptLua at d87f176](https://github.com/ASDAlexander77/TypeScriptLua/tree/d87f17681905a34d1cfd1bb5516b1a263d277b47):
  README describes Lua bytecode/source compilation, Lua 5.3 and an accompanying
  JavaScript library. That does not supply our managed continuation contract.

No external compiler was installed or benchmarked. These are source/documentation
comparisons; the executable proof in this spike is our bounded Lua target.

## Shared Scheme dialect and next gaps

The existing Scheme evaluator semantics remain the foundation. Tisyn's system
and compiler specifications provide the feature checklist, rather than a reason
to replace working lexical closures with call-site binding.

| Form                                | Lua translation in this spike                 |
| ----------------------------------- | --------------------------------------------- |
| entry `define`, local `define`      | module function, uniquely named locals        |
| `quote json-null`, scalar values    | portable Lua values                           |
| `json-field`, `=`, `not`, `truthy`  | field access and explicit value helpers       |
| `if` with `block` branches          | Lua branches                                  |
| `workflow-return`, `workflow-throw` | return, managed error propagation             |
| top-level `ensure (lambda () ...)`  | captured cleanup closure and `workflow.scope` |
| `yield-at` with elicitation request | opaque `workflow.effect` exchange             |

The translator consumes trusted compiler output. It is not a general Scheme
compiler or a new interpreter. This experiment does not yet implement compiler
passes in Scheme itself. The datum representation leaves that option open.

Next gaps include the remaining arithmetic and value operations, deterministic
globals, try/finally and scoped operations, loops, resources, structured children, and
inspection parity. Existing Hoot support must remain intact when extending Lua.
Unsupported forms fail compilation. No new Flow, Port, journal, or runtime
interface is needed for the proven subset. Teal remains later work.

## OpenCode CodeMode research

Inspected [anomalyco/opencode dev at d85746a](https://github.com/anomalyco/opencode/tree/d85746a054924241a7edde736eefd079dff9bc00/packages/codemode).
This is source inspection, not an execution or conformance claim.

- [Support matrix](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/codemode/interpreter-support.md):
  Acorn parses JavaScript, followed by interpreter admission; TypeScript syntax
  is rejected. Feature coverage and specific semantic gaps are documented,
  with upstream test262 fixtures as an additional oracle.
- [Scopes](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/codemode/src/interpreter/scope.ts):
  captured scope chains retain shared binding cells, including mutability and
  initialization state. Copying a closure's values would lose this behavior.
- [Interpreter](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/codemode/src/interpreter/interpreter.ts):
  each function invocation gets an explicit Frame and captured scope chain.
  Return/break/continue are explicit statement outcomes; throws and generator
  returns take separate paths. Try/finally handles abrupt completion explicitly.
  Host interruption bypasses the authored finalizer in the inspected try path;
  this is not our cancellation/cleanup contract.
- Generator suspension uses Effect fibers and Deferred responses. No portable
  continuation capture/restore API was found in the inspected execution path.
  Its in-memory frame model is useful inspiration, not evidence of durability.
- [Limits](https://github.com/anomalyco/opencode/blob/d85746a054924241a7edde736eefd079dff9bc00/packages/codemode/src/interpreter/limits.ts)
  bound allocations inside individual built-ins because cooperative timeout
  checks between evaluator steps cannot interrupt one large built-in operation.

The useful lessons here are explicit language coverage, binding-cell identity,
completion semantics, and bounded built-ins. No OpenCode code or dependency was
copied, and this does not propose another JavaScript interpreter for our runtime.
