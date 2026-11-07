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
- Domain Outcome replies, matching tool and sampling capability boundaries.
  Authoring conveniences lower explicit inspection/unwrap into the program;
  rejection enters throw/cleanup only when the program chooses it.

The frontend must verify emitted forms. The current experiment uses the existing
v1 typed Scheme IR verifier/emitter before returning S-expressions. A shared v2 serialized-module verifier now checks the bounded profile below;
a complete dialect/type validator and general linker are not implemented here.
The interface alone does not make arbitrary client-supplied Scheme safe or verified.
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

## Linking a compiled entry

`WorkflowLinker.link(WorkflowLinkRequest)` is a pure assembly contract. The request
contains a module, a caller `{ language, text }`, the public entry binding `name`,
and the host-selected evaluator `identity`. `LinkedWorkflow` carries the linked
source, language, entry names, required effect sites, and pinned program
identity. Implementations must bind source, evaluator and effect/source
metadata into that identity. This type alone does not verify untrusted artifacts.

The module's existing effect map describes required imports; linking neither grants
those effects nor installs handlers. The host still selects grants, validates
requests/replies and prepares the matching kernel. No additional import registry,
child execution mechanism or runtime lifetime is introduced.

The Scheme and Lua experiments implement this contract and their journal/reopen
journeys consume it. Both receive capability Outcomes as data; unwrapping is visible in the compiled IR.
Scheme supports admitted public names; the bounded Lua adapter currently accepts
only `review_draft`. Unsupported languages/bindings reject. These adapters remain
experiment-local: the shared contract does not imply a general linker, arbitrary
module graphs, equal language coverage or portable inspection. A second substantial
workflow is still needed before broadening their implementation into public packages.

## Serialized module verification

`verifyWorkflowModule(module)` is a pure check called by the Scheme target and both
experimental linkers. It checks function-only top-level structure, lexical bindings,
duplicate parameters, entry arity, form arity, effect metadata and literal yield-site /
effect-identity correlation. Verification reads data only, creates no Guest and
installs no grants. It throws before target emission on unsupported input.

The supported serialized profile is intentionally bounded to the exercised string
and boolean literals, lexical functions/lambdas, list construction, json-field,
js-add, not/truthy, local definitions/assignment, conditional blocks, try-finally,
return/throw and declared effect exchanges. The compiler-profile reader consumes the
entire source and limits size/depth; it rejects arbitrary Scheme reader extensions
and numeric syntax. It is distinct from the Scheme runtime's general JSON wire codec.
Targets may reject additional forms they do not implement. This is structural
verification, not a proof of termination, successful return, schema compatibility,
source provenance or authorization. Consumers verify the exact module at use; there
is no cached verification token that could survive mutation.

The `workflow-contract.acceptance.test.ts` consumer uses the existing public
`defineTool(name).parameters(...).capabilities(...).elicits(...).execute(...)` builder,
with inferred string output. The public TypeScript build API now compiles that
directive-bearing source during acceptance, and both fresh and cached artifacts exercise
create-draft, approval, send/delete and their domain failure branches through native
tools, Scheme and Lua on both native runtimes, restoring VM checkpoints between
requests. No actual email is sent. The portable IR has a different entry and effect
set from the review fixture. This establishes the bounded public tool build and linker path, not general object
lowering or crash-safe email delivery. The build API and cache limits are documented
in codemode-compiler-frontend-typescript.
