# @sweatpants/workflow-kernel

Review scaffold: portable program/snapshot identities, evaluator interface and
exact compatibility checks. There is no Hoot/Wasm implementation yet. Building
this package builds TypeScript declarations and ESM, not Wasm.

The kernel owns logical calls, environments, scopes and cleanup. External effects
and journal acceptance belong to the host. dispose/close release compute;
cancel requests logical unwind and may yield cleanup effects.

Effection supplies operation types; foundation supplies the existing Json type.
There is no import-time instance creation. Scheme/TS frontends
will target a separately specified instruction format; code: unknown does
not yet define that format.

The host must bind snapshots to input/task identity and an accepted journal
frontier. Compatibility checks are not content integrity or authorization.

## Review before implementation

- Bounded compute slices behind operation-based advancement.
- Instruction and snapshot format definition.
- Fault/fuel exhaustion outcomes and whether failed executions remain usable.
- Cancellation of completed execution and repeated cancellation during cleanup.
- Capture boundaries and atomicity on invalid replies.
- Schema validation ownership at the adapter/kernel boundary.

A concrete implementation must earn fresh-instance restore and composition
guarantees through behavioral tests. Current tests cover identity checks only.

## Intended build and distribution

Reuse the scheme-runtime pinned Docker/Hoot build pipeline. Later wasm:build
will generate the kernel and required Hoot support assets; wasm:verify rebuilds
and compares them. Consumers use prebuilt artifacts. Node/Worker loaders will
be added when real artifacts exist. No placeholder Wasm exports are provided.

Execution methods are Effection operations. Each KernelExecution binds its private
handle; callers do not supply handles or thread a generic Execution type. Code
and snapshot state are unknown until the selected kernel validates their format.
Validated effect requests/replies use foundation Json. Operation does not make a
synchronous Wasm call interruptible.
