# flowmode-runtime

Documentation-only scaffold. See the [ownership and promotion plan](../../docs/workspace/FLOWMODE.md).

Intended responsibility: language-neutral kernel, authoring/composition, identity,
compatibility, and inspection contracts.

Current owner: [workflow-kernel](../workflow-kernel/src/index.ts). Promotion must
rename/migrate the existing owner and consumers together, rather than copy its
contracts. Generic Execution/Exchange lifecycle and scoped ports remain in
`foundation`; this layer specializes them for workflows.

Readiness evidence: compatible implementations, lifecycle guards, explicit
inspection availability, snapshot identity checks, and a real consumer. Shared
code must not import language-specific Wasm implementations or the journal backend.
