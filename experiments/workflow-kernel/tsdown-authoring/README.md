# SDK workflow artifact build

`apps/yo-workflow/execution/review-draft.workflow.ts` authors an ordinary `createDurableTool(...).execute`
generator containing `"use workflow"`.

The tsdown plugin emits separate surfaces:

- `dist/review-draft.workflow.mjs`: the normal SDK DurableTool and its declarations.
- `dist/review-draft.workflow.artifact.mjs` (Scheme) and
  `dist/review-draft.workflow.lua.artifact.mjs` (Lua): portable CompiledWorkflow data and a
  declaration that infers input/output from the normal tool type.

The build config supplies explicit export contracts and imported binding
contracts. The compiler returns structured diagnostics. It statically recognizes
named execute generators and literal builder declarations, including a small
whitelist of Zod schema constructors; it never evaluates author modules. Dynamic
builders, imported schema factories, undeclared effects and unsupported source
receive diagnostics. The MVP's portable contracts are explicitly permissive JSON
contracts; compiler parsing is not a claim of runtime schema equivalence.

The Scheme target privately reorders SDK `(input, ctx)` parameters into its
calling convention. `{ message }` elicitation requests lower to the same intrinsic
used by the Lua adapter. Context/document elicitation fields are not supported by
this compiler subset and are rejected.

Run the build with `pnpm --filter yo-workflow execution:compile`. The app imports
the artifact, so no compiler, SDK builder or model provider executes on artifact
import. Ordinary tool imports retain the SDK's standard behavior.

The implementation is promoted to `packages/flowmode-compiler*` and the standalone
artifact adapter lives in `packages/vite-plugin`. These fixtures prove the explicit
artifact build API. The app itself imports the ordinary tool and uses automatic Vite
compilation; it no longer depends on running this build before startup.
