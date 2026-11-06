# Code authoring and composition

`@sweatpan.ts/codemode` is the portable consumer entry point. It exposes
`CodeAuthoring`, `createCodeAuthoring`, and intentional re-exports of validation
and execution contracts. Import concrete language adapters separately; this entry
point does not load Wasm, a compiler, a model provider or a database.

```ts
const authoring = createCodeAuthoring(runtime, "authoring", {
  *describe({ bindings }) {
    return { language: "lua", instructions: describeSelectedBindings(bindings) };
  },
});
const validation = createCodeValidator(
  runtime,
  "validation",
  createLuaValidator(runtime, loadModule),
);
const guide = yield * authoring.operations.describe({ bindings: selectedDescriptions });
const checked = yield * validation.operations.validate({ language: "lua", text: source });
```

The description function and selected catalog above are application-owned. Binding
contract text may contain schema projections, but is never a validator or grant.
Authoring describes capabilities; it does not sample a model. Validation does not
admit or run a program. Scoped `around` and `install` select trusted behavior per
operation, using the existing Runtime API. No new dispatcher or ownership loop.

## Package boundaries

- **execution** owns Kernel, PreparedProgram, Guest, acquisition, checkpoints and program resolution.
- **codemode-runtime** owns source/diagnostic/validation contracts and re-exports
  the execution types useful to evaluator consumers.
- **codemode-runtime-lua** implements the current evaluator and compile-only
  validation with the pinned VM. **codemode-runtime-scheme** adapts a trusted Scheme Execution machine loader to
  Guest/Kernel/checkpoints; its compiled-tool journey reuses the existing Hoot evaluator.
- **codemode-compiler** owns the shared workflow Scheme S-expression module and
  frontend/target contracts. **codemode-compiler-frontend-typescript** declares the
  source/declaration input boundary; its implementation remains experimental.
  **codemode-compiler-scheme** wires this IR for the Scheme kernel;
  **codemode-compiler-lua** remains a reserved target adapter.
- **codemode** owns authoring guidance and higher-level consumer composition.
  A language bundle, catalog projection and code-tool factory remain proposals.
- **tools/hosting/durable** retain tool declaration, grants, ownership and accepted
  history. Code mode must compose these rather than create a second replay engine.

## Proposed compiler/linker shape (not exports)

Adapt v1's CompileRequest/CompileResult, CompiledWorkflow, WorkflowCompiler,
WorkflowLinker and binding/export declarations with their actual consumer. Keep
host-capability, owned-child and linked compiled-function bindings distinct.
Artifacts must identify their format and imports; resolution verifies the pinned
program before acquisition. Compiler dependencies belong on build-time paths.
The TypeScript frontend has its own package contract. The initial portable IR
profile is workflow Scheme S-expressions; general linking remains unimplemented.
Do not copy legacy interfaces that leak Effection into portable contracts.

Inspection is optional and language-specific. The generic Kernel now prepares existing acquisition/checkpoint recipes; it does
not duplicate Guest methods. Do not imply all languages support checkpoints,
critical regions or lexical inspection. Re-export existing contracts directly.

## Evidence and remaining assembly

`codemode-authoring.acceptance.test.ts` exercises both native runtimes: scoped
guidance, a scripted author's invalid/corrected source, compile-only validation,
real Lua execution through grants and SQLite hosting, accepted replay, scoped
validation policy and infrastructure failures. Source and emitted declarations are
checked by the landing gate. No live model or browser is involved.

The consumer owns catalog permission/elicit coverage, model sampling and repair
policy, exact source and binding retention, program identity, and advancement.
The test uses one fixed program identity for its fixed source; a dynamic authoring
app must resolve and pin each admitted artifact. Full model-authored chat, nested
presentation, compiled developer workflows and computation approval remain future
assemblies. No manual plugin revision field is introduced.
