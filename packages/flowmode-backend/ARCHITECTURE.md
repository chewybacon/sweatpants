# @sweatpants/flowmode-backend

Adapts a `WorkflowKernel` to the shared `ProgramBackend` contract exported by
`journal-authority`. It does not implement another ProgramDriver or routing layer.

```text
ProgramPeer → createWorkflowProgramDriver(backend)
  → shared attachment (ordering, receipts, attempts, pending operations)
    → ProgramComputation.run()
      → kernel start / restore / resume / cancel
```

The same driver accepts a durable-tool registry, which selects the ordinary
Effection backend, or an explicit backend:

```ts
const backend = createKernelProgramBackend({
  kernelIdentity,
  createKernel,
  loadProgram,
  manifest,
  bindOperation,
});
const driver = createWorkflowProgramDriver(backend);
```

`bindOperation` maps kernel requests to existing durable operation descriptors,
including child invocations. The shared host owns child routing, journal admission,
effect placement, and authorization. Installed effect attempts use the existing
`InstalledEffectPort`. Kernels receive accepted results through the shared runtime.

## Recovery and lifetime

The shared driver captures an envelope containing input/program/task identity,
action index, frontier digest, and backend state. The kernel backend captures the
kernel snapshot inside that envelope. On restore, the backend publishes the saved
boundary and the attachment creates fresh pending-operation resolvers at the
saved action index. Accepted suffix entries then use normal command handling.

Effection generators recover by replay. Kernel checkpoints are selected by scoped
`ProgramRecovery` middleware. Physical disposal releases compute without requesting
logical cancellation; logical cancellation is passed into the kernel and may yield
cleanup effects. The resource scope also disposes partially acquired compute.

The artifact loader must verify content hashes. Checkpoint provenance and accepted
journal position belong to the authority; snapshot identity checks are not auth.
No driver, backend, or Wasm module is installed merely by importing this package.

The Lua and Scheme Execution implementations live in
`packages/flowmode-runtime-lua` and `packages/flowmode-runtime-scheme/src/execution`.
Their program adapters use this package; Wasm builds remain owned by the runtimes. Kernel boundaries currently expose operations and
terminal results, not emissions. Native generator emission support is unchanged.

## Pinned program bundles

`createKernelProgramBundle(implementation, identity, contract)` rejects incompatible
program formats and creates a detached artifact/manifest pair. Its versioned digest
covers executable payload, kernel identity and durable contract. `loadKernelProgram`
recomputes that digest, checks both claimed digests and the requested identity, and
returns detached code. This replaces Hoot's local digest construction and claimed-
digest-only loader. It does not authenticate an artifact or journal position.

`KernelBackendDependencies` extends the shared `WorkflowRuntime` acquisition
contract. Artifact loading remains separate from runtime acquisition; the existing
`prepareWorkflow` lifecycle still owns cleanup and compatibility checks. No driver
registry or second runtime is introduced by these contracts.
