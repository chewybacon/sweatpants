# flowmode-compiler-scheme

Documentation-only scaffold. See the [ownership and promotion plan](../../docs/workspace/FLOWMODE.md).

Intended responsibility: expose the shared workflow Scheme representation as the
Scheme target and assemble its compiled artifact with source/binding metadata.

Current implementations: [scheme-compiler](../../experiments/workflow-kernel/scheme-compiler/README.md)
and [tsdown-authoring](../../experiments/workflow-kernel/tsdown-authoring/README.md).
The Scheme intermediate representation is shared with Lua lowering; this target
must not duplicate the frontend. Confirm that separate packaging is justified
before adding a manifest.

Readiness evidence: compiled developer functions compose with authored Scheme
callers, preserve source identities, and suspend/restore through cleanup. Runtime
evaluation belongs to the Scheme runtime, not this compiler target.
