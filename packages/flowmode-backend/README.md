# @sweatpants/flowmode-backend

Workflow kernel integration with the shared program attachment and journal authority.

`createKernelProgram({ bundle, runtime, bindOperation })` assembles a verified
`KernelProgramBundle` and a `WorkflowRuntime` through the existing
`createWorkflowProgramDriver`. Its `createDriver()` shares manifest lookup,
artifact verification and backend construction across language adapters. It does
not introduce another execution loop or own the journal. Kernel acquisition stays
on the runtime; `prepareWorkflow` supplies scoped acquisition and disposal.

See [architecture and contracts](./ARCHITECTURE.md) for the existing implementation
and [the Flowmode plan](../../docs/workspace/FLOWMODE.md) for remaining promotion
work. The package move preserves current interfaces and behavior.
