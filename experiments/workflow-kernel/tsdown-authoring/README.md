# Compile a developer workflow with tsdown

This is a build/import seam experiment, not a published package or a Vite integration.

```sh
pnpm --filter yo-workflow execution:compile
pnpm --filter yo-workflow execution:test
pnpm --filter yo-workflow execution:dev --port 8131
```

Use Node 24. The build invokes pinned tsdown 0.23.1 and TypeScript 5.9.3 through
pnpm's tool cache; it does not modify workspace dependencies.
The first invocation needs registry access. Generated `dist/` is untracked.
Rebuild after changing the generator; restart the local lab to load the new module.
Vite watch integration is deliberately the next increment.

## Import contract

`review-draft.workflow.ts` exports `defineCompiledWorkflow(review_draft)`.
The wrapper is a typed build marker and throws if executed without compilation.
The tsdown plugin replaces that module with portable definitions; it never
executes the developer module. Unmarked generators and unsupported top-level code
fail compilation. This initial module grammar allows workflow functions, type
aliases/interfaces, supported Effection imports, and named definition exports.
The marker import currently uses the experiment-local `./definition.ts` path.

The output is a `CompiledWorkflow<Input, Output>` object containing:

- private Scheme implementation and its entry name;
- original TypeScript source and compiler site/line metadata;
- a type-only optional `types` property retaining input and inferred return types.
  This property is absent at runtime.

Declarations describe the definition object, not a callable JavaScript generator.
Type inference does not generate runtime schemas. The host still supplies schemas,
capability policy, effect bindings, and the registered public name. This artifact
is not yet an SDK DurableTool and must not be installed as one by a cast.

The lab imports the generated definition and registers its entry as `review_draft`
in the same Hoot program as the model's caller and the ordinary host effect
`send_announcement`. The existing program digest covers the linked program.
This adds no checkpoint format, migration promise, or second execution mechanism.

## Evidence

- tsdown emits an ESM module and declarations from the same definition source.
- `consumer.ts` checks inferred input and literal output types with negative cases.
- `transform.mjs` checks source locations and rejects unsupported modules.
- `runtime.mjs` blocks compiler imports, then restores both human boundaries,
  completes cleanup, and invokes the host tool through the real journal/driver.
- Existing inspector tests cover decline and cancellation as well as approval.

The pure `compileWorkflowModule` function is independent of tsdown. The thin
Rolldown load hook is the first adapter; a Vite adapter can reuse the transform.
The inspector's source metadata is preserved, but full debugger source maps for
execution stepping are not provided by this spike.

## Standard definition envelope

`defineCompiledWorkflow` retains its input/output inference and `"use workflow"`
requirement. Its return type is now the shared `CompiledWorkflow` contract from
`workflow-kernel`. The build output stores the emitted code in
`implementation: { format: "workflow-scheme-definitions-v1", payload: ... }`;
`sourceLanguage: "typescript"`, original source and debug metadata remain separate.
The old top-level `scheme` field is removed.

The runtime imports no compiler. The Hoot linker owns definition-format checks,
entry checks, registration syntax, duplicate names and shared-module deduplication.
A new compiler target would emit another implementation format rather than
changing the shared definition envelope. The current compiler still targets Hoot.

`workflowCompiler` implements the shared `WorkflowCompiler` interface and returns
a map of portable definitions. `compileWorkflowModule` wraps that map in ESM
exports for tsdown. The compiler rejects other source languages explicitly; this
separates its pure output contract from the bundler adapter without introducing a
second target.
