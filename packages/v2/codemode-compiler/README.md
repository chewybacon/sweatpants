# Shared workflow compiler boundary

The common IR is a bounded **Scheme S-expression dialect**, carried as text in
`WorkflowModule.sexpressions`. A typed AST may help a frontend construct and verify
it; it is not the interchange representation. No ScriptC nodes cross this boundary.

`WorkflowFrontend<Input, Y>.lower` produces that module in an ordinary Operation.
`WorkflowTarget<Artifact>.emit` consumes it. These are contracts, not a new scoped
service or middleware registry. Assemblies select implementations explicitly and
own compiler resource lifetimes. Compilation does not acquire a Guest or grant
permission to invoke a capability.

The initial `workflow-scheme/1` profile contains:

- Definitions in the existing workflow Scheme dialect: lexical bindings, closures,
  calls, return, explicit `yield-at` exchanges and protected `try-finally` cleanup.
- One named entry taking one input value. Targets supply invocation syntax.
- Effect sites with declared effect identities, author aliases and original
  source coordinates. Schemas and handlers remain with the owning assembly.
- Direct successful reply values; failure enters the kernel's failure/cleanup path.
  This is an experimental compiler profile, not v2 ToolContext's Outcome API.

The frontend must verify emitted forms. The current experiment uses the existing
v1 typed Scheme IR verifier/emitter before returning S-expressions. A shared v2
reader, complete dialect validator, and linker are **not implemented** here yet.
The interface does not make arbitrary client-supplied Scheme safe or verified.
Metadata is JSON-serializable, not an immutable/pinned program identity; the caller
must retain the artifact and its declaration/runtime resolver together.

## Implementations

- `codemode-compiler-frontend-typescript`: source/declaration input contract; the
  ScriptC-backed implementation remains in the experiment, outside production.
- `codemode-compiler-scheme`: consumes the common module and wires its entry for
  the existing Scheme Execution kernel. No TypeScript or ScriptC dependency.
- `codemode-compiler-lua`: reserved lowering of this same S-expression dialect;
  no v2 implementation yet. Future targets should consume this same boundary.

The ScriptC acceptance journey runs a recorded frontend adapter, serializes the
module through JSON, passes it to the Scheme target and exercises fresh-machine
restore and cancellation on both host runtimes. Manual pinned frontend extraction
establishes source-to-IR provenance; acceptance does not spawn ScriptC.

## One effect lowering

The shared module's `effects` map records registered effect identities at exchange
sites. It does not classify them as sampling, elicitation, or a server capability.
Those distinctions live in authoring declarations and the host's bindings. The
TypeScript frontend receives selected effect declarations; syntax such as
`ctx.elicit` resolves to one of them before lowering.

The current experiment lowers that call to `yield-at` with an effect request and
decodes it into the existing `CapabilityRequest { effect, input }`. No new kernel
opcode, effect registry or delivery mechanism was introduced. The message/string
payload encoding remains bounded to this fixture; general payload lowering and
sampling authoring still need their own consumers. In particular, streaming model
sampling must retain its existing stream contract rather than being flattened
into a new compiler-specific sampling primitive.
