# flowmode-compiler

Documentation-only scaffold. See the [ownership and promotion plan](../../docs/workspace/FLOWMODE.md).

Intended responsibility: shared TypeScript workflow admission, binding/source
metadata, Scheme intermediate representation, and portable artifact build tooling.

Current implementations: [scheme-compiler](../../experiments/workflow-kernel/scheme-compiler/README.md)
and [tsdown-authoring](../../experiments/workflow-kernel/tsdown-authoring/README.md).
Determine the shared frontend/target boundary before extracting workspace members.
The ordinary SDK DurableTool export must remain distinct from compiled artifacts.

Readiness evidence: explicit supported syntax, fail-closed diagnostics, declared
binding contracts, matching source identities across targets, and compilation of
the same developer tool into both language artifacts. This layer does not own VM
execution, model-authored game source, or journal persistence.
