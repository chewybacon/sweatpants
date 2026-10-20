# flowmode-runtime-scheme

Documentation-only scaffold. See the [ownership and promotion plan](../../docs/workspace/FLOWMODE.md).

Intended responsibility: Scheme evaluation, bounded host exchanges, and the
checkpoint-capable Scheme kernel with reproducible Hoot/Wasm build inputs.

Current implementations: packaged [scheme-runtime](../scheme-runtime/package.json)
for Playground and experimental [hoot-composition](../../experiments/workflow-kernel/hoot-composition/README.md)
for Execution. These are distinct evaluator paths today. Their ownership and any
convergence need a deliberate design; this scaffold does not replace either.

Readiness evidence: retain Playground language/game behavior and validation limits,
preserve compiled-tool composition and inspectable frames in Execution, and prove
cleanup and fresh-instance restore. Document replay versus continuation recovery
at each consumer. Migration must remove superseded paths without compatibility
aliases or silently reducing the supported Scheme language.
