# Scheme workflow target

The portable root exports `schemeWorkflowTarget.emit(module)` and
`admitSchemeCaller(text)`. The target verifies the bounded shared S-expression module
and returns `{ format: "scheme-execution/1", source, effects }` for the Scheme kernel.
It has no frontend, ScriptC, VM, or Node dependency.

The Node `@sweatpan.ts/codemode-compiler-scheme/link` entry exports
`schemeWorkflowLinker`, implementing the shared `WorkflowLinker` contract:

```ts
const linked = schemeWorkflowLinker.link({
  module: artifact.module,
  caller: { language: "scheme", text: "(sendEmail %input)" },
  name: "sendEmail",
  identity: schemeRuntimeIdentity,
});
```

Linking verifies the module, admits/re-emits the caller and isolates the private
compiled definitions behind one registered entry. The public name must be a valid,
non-reserved Scheme identifier distinct from compiled definition names. `root` is
reserved. The program hash binds executable source, runtime identity and effect/source
metadata. It is compatibility identity, not an authorization or authenticity proof.

Caller admission is bounded to 12K characters and the reader's depth/node budgets.
It rejects internal workflow instructions and unsupported reader extensions; numeric
literals must be safe integers. Runtime caller validation additionally enforces the
registered binding's immutability and permitted operations. Admission alone is not a
full static language/type checker or termination guarantee.

Assembly selects grants, validates request/reply schemas, decodes effect payloads and
acquires the matching kernel. Checkpoint inspection remains experimental and is not
exported here. The public tool acceptance journey compiles `sendEmail`, links it under
that name, and restores between effects on both host runtimes. The older review and
cancellation experiments delegate to this implementation.
