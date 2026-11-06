# ScriptC frontend → Scheme experiment

This experiment runs a pinned ScriptC frontend, records its real IR, projects the
review generator into our verified Scheme IR, and executes it through the v2-owned
Hoot machine. It changes neither the production compiler nor either kernel.

The consumer is `review.ts`: approval suspends, the reply updates a captured
mutable reservation, and `finally` calls the captured closure and suspends again.
The v2 acceptance journey `scriptc-scheme.acceptance.test.ts` exercises normal
completion and cancellation at either boundary across Effect and Effection.
Each journey physically closes the guest and restores into a fresh machine at
both boundaries. Normal cleanup sees `release:yes` and preserves `approved:yes`;
body cancellation sees `release:draft`; repeated cancellation preserves cleanup.
These are in-process logical checkpoint journeys, not process-crash or SQLite
integration evidence. Existing Scheme journeys separately cover journal reopen.

## Reproduce the frontend extraction

The installed dependency is now `@scriptc/compiler@0.3.6`, owned exclusively by
`packages/v2/codemode-compiler-frontend-typescript`. Its pnpm patch exposes the two
internal frontend modules; the package-owned adapter closes tsgo in `finally` and
checks that the requested root survives lowering. The lockfile pins the release
and patch. Optional LLVM/native runtime payloads are excluded.

From this repository, with Node 24.22.0 and workspace dependencies installed:

```sh
node --conditions=development --import tsx experiments/workflow-kernel/scriptc-scheme/extract.mjs
pnpm --filter @sweatpan.ts/acceptance test __tests__/applications/scriptc-scheme.acceptance.test.ts
```

Earlier extraction used the source research revision
`c04f7701045d89354b6ad4ea485732f5b79b3f06` (Apache-2.0). The installed npm release
reproduced both recorded probe IR hashes exactly. That is fixture parity evidence,
not a claim of complete source equivalence. No external checkout is required now.
The only IR normalization remains absolute source paths.

Observed extraction: no preflight or lowering diagnostics.

- Source SHA-256: `f3871c5a9aacdd345cce72969bab9b0a90ba7a018c02405eb1f4439245fdbb8c`
- Recorded IR SHA-256: `f522520227dca06cdcf47db2f3cfd82b3f1ca78d4430a7fa567124a74211889a`

Acceptance uses the checked-in IR so it requires neither an external compiler
installation nor subprocesses. It runs the projection and existing IR verifier on
every execution; generated Scheme is not a frozen fixture. The frontend was also
run independently on this source during the experiment. CI does not independently
revalidate that source-to-IR relationship.

## Boundary and limitations

`project.mjs` is an experiment for this recorded module, **not a compiler for
arbitrary ScriptC modules**. It selects the named export and its lifted closure;
it does not execute the generated module initializer or entrypoint. That is valid
for this source, which has no top-level effects or imports. Supporting modules
requires an explicit initialization and effect-admission design.

The supported path is string locals, explicit capture cells, closure calls,
string concatenation, ordinary generator yields, assignment, return, and
try/finally. Other encountered expression/statement kinds reject. A synchronous
closure must have one return statement. ScriptC's unreachable runtime fence is
preserved as a workflow failure rather than erased. Binding object identity is
shared between the parent and capture; the existing Scheme IR verifier checks it.

This projection intentionally interprets yield as a workflow exchange. It does
not implement JavaScript generator objects, `.next`/`.return`, delegated yield,
Promise/async semantics, or the ScriptC runtime ABI. Cancellation remains the
Scheme kernel's explicit protocol and preserves cleanup on repeated requests.
The strings are an elicitation probe, not a demonstrated typed `ctx.elicit` SDK
adapter. TypeScript source spans supply yield-site debug metadata.

The `.mjs`/`.d.mts` experiment boundary isolates the legacy Scheme emitter from
v2 declaration compilation. The target IR is runtime-verified, but this projector
is not statically checked against ScriptC's IR types. A promoted adapter should
pin a typed input contract and admission rules rather than keep this loose bridge.

## Conclusion

Frontend reuse is technically plausible without adopting LLVM or replacing our
checkpoint runtime. ScriptC already supplies the binding and closure analysis
needed here. The next useful experiment is a real `use workflow` declaration with
`ctx.elicit` and one imported helper: identify which IR calls are admitted workflow
capabilities, and reject unsupported host access before execution. Do that before
porting the compiler or adding ScriptC to the product dependency graph.

## Authored workflow and imported helper (second probe)

`workflow/review.workflow.ts` now exercises the actual authoring syntax:

```ts
export function* review(title: string, ctx: Context): Operation<string> {
  "use workflow";
  // imported message(), shared mutable capture, and yielding finally
  const decision = yield* ctx.elicit("approval", { message: message("approve:", title) });
}
```

The source imports Effection's `Operation` as a type; the standalone source passes
TypeScript's strict check. This is an authored workflow function with a local
context contract, not the full SDK `createDurableTool`/Zod registration wrapper.
The two elicits have string reply schemas. Their authoring types and allowed keys
come from existing effect declarations; general schema-to-IR lowering remains
outside this experiment.

The successful route is:

1. `admit.mjs` resolves the context **binding**, admits only directly delegated
   `ctx.elicit` calls for this probe's approval/cleanup contract, and preserves
   their original source locations. It rejects context escape/reassignment,
   unknown keys, raw yield, host calls, and unapproved imports.
2. It normalizes each admitted call into an explicit exchange yield and gives
   ScriptC a `Generator<string[], string, string>` entry. The original function's
   context parameter and type-only declarations are absent from that input.
3. ScriptC resolves the ordinary helper import and lowers lexical bindings and
   captures. The helper module is admitted only as a pure two-string concatenation
   function; executable module initialization is rejected before extraction.
4. The shared projector emits the helper's IR body as a synchronous Scheme lambda,
   exchanges as `yield-at`, and cleanup as the existing `try-finally` form.

The raw Generator-typed control probe showed why admission belongs before
ScriptC's generator lowering: each `yield* ctx.elicit` became a `seqExpr` with
`genResume`, a done flag and a delegation loop. Recovering a capability call by
matching that lowered control flow would couple us to compiler internals.
Compiling Effection itself is explicitly out of scope. `Operation` is an authoring
type; the runtime object protocol is neither needed nor executed. The earlier
direct-extraction control was not a required milestone or a product blocker.
The extractor and projector still require the expected normalized entry to exist;
empty diagnostics alone are not execution evidence.

Reproduce using the installed package-owned frontend:

```sh
node --conditions=development --import tsx experiments/workflow-kernel/scriptc-scheme/extract-workflow.mjs
pnpm exec tsc --ignoreConfig --noEmit --strict --target es2022 --module nodenext --allowImportingTsExtensions --skipLibCheck experiments/workflow-kernel/scriptc-scheme/workflow/review.workflow.ts experiments/workflow-kernel/scriptc-scheme/contract.typecheck.mts
pnpm --filter @sweatpan.ts/acceptance test __tests__/applications/scriptc-scheme.acceptance.test.ts
```

The extractor removes its temporary files and disposes tsgo. Recorded normalized
source, IR and hashes live in `workflow/`. Acceptance reruns admission, checks
source/helper/normalization/IR hashes, projects the recorded IR, and exercises the
real v2 Scheme machine. Changing source without re-extracting fails. These hashes
bind the fixture together; they do not replace rerunning the external frontend.
Original exchange locations are checked; other debug locations still refer to
normalized source. Admission validates the exact supported entry/helper signatures before rewriting
them. ScriptC checks the retained body/helper types; the standalone TypeScript
command above additionally checks the complete original Effection authoring API.

The focused suite now has 13 passing cases: the original six, six matching
workflow/helper recovery cases across both runtimes, and negative authoring
admission plus source-location evidence. The workflow cases restore fresh machines
at both exchanges and preserve capture updates, pending return and cancellation.

This remains an assembly experiment. Admission is intentionally restricted to
this entry signature and helper shape; it is not a general module graph loader or
security sandbox. The `.mjs` bridge still lacks a statically pinned ScriptC IR
contract. No production compiler, package export, middleware or kernel changed.

The next design boundary is a small admitted workflow representation: explicit
capability identity, request/reply schema and authored source location, before
ordinary language lowering. We should reuse the current tool declaration and
elicitation contracts for that boundary rather than invent a second tool registry. A stable upstream frontend
hook could eventually replace source normalization; none was established here.

## Declaration-driven admission

`contract.mts` now declares the two elicits with the existing v2 `defineEffect`:
identity, input schema and response schema have one assembly-owned source. The
experimental `WorkflowContext` derives caller/reply types from those schemas.
The compiler accepts the declaration map (the same shape as a tool's `elicits`)
rather than maintaining its own key list. No new registry or framework API exists.

Admission embeds the declared effect ID in the normalized exchange and keeps the
source alias and location as debug metadata. Thus changing the effect identity
changes the emitted program. The decoder checks the exchange against its admitted
site and produces the existing `CapabilityRequest { effect, input }` shape.
Compilation grants no authority. Host-side schema validation, transformations,
delivery and outcome policy remain with the existing host assembly; the hosted acceptance journey also exercises response validation and exact
journal authority through that pipeline. Schema changes still
require the application to pin its program/contract resolver appropriately.

The local authoring adapter continues to return a successful reply directly and
uses kernel failure/cleanup for errors. That is an explicit experimental choice,
not a claim that it implements v2 `ToolContext.elicit`'s `Outcome` return API.
The contract typecheck proves valid inference and rejects unknown aliases, bad
inputs and wrong reply types. Acceptance also rejects a missing declaration and
an exchange that uses the wrong effect ID for its admitted source site.

Effection compilation is not on the roadmap for this experiment. The remaining
question is promotion of the admission adapter, including its reply/error policy
and integration with complete tool declarations—not compilation of a native
runtime into a second runtime.

## Frontend/target scaffold trial

The authored-workflow journey now implements the public
`TypeScriptWorkflowFrontend` contract from the new
`@sweatpan.ts/codemode-compiler-frontend-typescript` scaffold. Its explicit input
contains authored source, admitted helper text and existing effect declarations.
The recorded adapter still checks those inputs against pinned extraction hashes;
it is not a production ScriptC loader.

Its output is `WorkflowModule` from `@sweatpan.ts/codemode-compiler`: the common
Scheme S-expression text, single-input entry, and admitted elicitation identities
with source locations. The acceptance journey serializes that module through JSON
before passing it to `schemeWorkflowTarget.emit`. The target depends only on the
shared compiler contract, adds entry invocation, and returns the source consumed
by the existing Scheme kernel. It sees no ScriptC nodes, authored source graph or
schema instances. Recovery and cancellation cases now run through this path.

The shared package owns the IR contract; the Scheme target does not own the IR.
A shared v2 S-expression parser/complete verifier and general linker remain future
work. Today the existing legacy typed emitter verifies the frontend's generated
forms. Lua and other targets are still unimplemented v2 consumers of this boundary.

## Effect primitive correction

The shared module and TypeScript frontend input now use `effects`, not `elicits`.
`WorkflowEffectSite` references an existing registered effect. The frontend may
recognize `ctx.elicit` as authoring syntax, but emits the same effect request
boundary intended for sampling and other registered operations. The fixture's
normalized tuple now carries the `effect` tag and decodes to CapabilityRequest.
Its message/string payload is still a bounded adapter encoding; this change does
not claim a general payload compiler or working sampling frontend.

V1's primitive journal context exposes sample/elicit/effect separately, while its
Scheme compiler has a generic registered-effect exchange path. This correction
keeps the shared v2 IR independent of those authoring conveniences. Sampling policy,
streaming and effect implementations remain host-owned; no new kernel primitive.

## Compiler-owned IR macro experiment

`contract.mts` now owns an immutable-by-type macro vocabulary: `elicit` selects
approval and `effect` selects cleanup. The mapped `WorkflowContext` exposes only
those method/key pairs and derives their input/reply types from existing effect
schemas. `macros.mts` derives structured authoring guidance with call syntax,
effect identities and JSON schemas from the same declarations. Sampling is not
advertised because no sampling expansion is implemented in this experiment.

The source invokes `ctx.elicit("approval", ...)` and `ctx.effect("cleanup", ...)`.
Admission resolves the lexical context binding and consults the trusted macro
catalog. The expansion emits an explicit effect exchange before ScriptC's generic
lowering; the shared S-expression IR contains no macro names or expansion code.
Switching the cleanup authoring syntax did not change the normalized source or
ScriptC IR hashes. Both spellings use the existing effect primitive.

`boundary.mts` consumes only the emitted module's effect-site metadata plus a
separate assembly-provided allowlist. It refuses an ungranted required effect and
checks each actual exchange against its admitted site. It then produces the
existing CapabilityRequest. No handler, schema transform, host delivery or journal
is implemented here: this is an assembly-local capability ceiling, not a replacement
for the host's existing authority checks. Macro availability is not an authority
grant. The runtime does not execute or import macro expansion functions.

Acceptance now checks the generated guidance, refuses unsupported macros and
method/key combinations, rejects absent sandbox grants, and runs both admitted
macros through the same checkpoint/cancellation journeys. A newly constructed host assembly must supply its own allowlist; it is not taken
from authored code or a guest checkpoint. These tests restore machines under the
same assembly policy, rather than recreating the entire host. Type checks cover valid calls, unknown keys and input/reply types.

These are bounded single-exchange macros. The request encoding still supports the
fixture's message object and string reply only. Multi-step expansions, general
payloads, sampling/stream semantics and plugin-defined macro installation are not
implemented or promoted. The macros live in the experiment until more consumers
establish those contracts; no additional framework API or kernel opcode was added.

## Live frontend path

```sh
node --conditions=development --import tsx experiments/workflow-kernel/scriptc-scheme/run-live.mjs
```

This manual integration runner uses `live.mjs`, a live implementation of the
TypeScript frontend contract. It does not read `review.ir.json`, normalized source
or provenance. It admits the current source graph, invokes the installed ScriptC
adapter, projects to the shared S-expressions, JSON-round-trips the module, emits
through the Scheme target, and runs the real kernel with explicit effect grants.

Twelve journeys cross original/edited source with normal/body-cancel/cleanup-cancel
on Effect and Effection. Both suspension points are captured, physically closed
and restored into fresh machines. The edited workflow returns `published:yes`
instead of `approved:yes`; its helper parameters are also renamed. Neither edit
requires refreshing recorded fixtures. Unsupported macros and a TypeScript input
type error reject; a subsequent compilation still succeeds.

`assembly.mjs` now holds admission/projection shared by live and recorded frontends.
`project.mjs` is side-effect-free with respect to fixture loading; the original
plain-generator fixture moved to `generator.mjs`. `input.mjs` loads authored source
only. The recording command calls the same live compiler and saves its intermediate
output for deterministic acceptance; it is no longer a second compilation pipeline.
The unchanged probe still reproduces its prior IR hash.

The ordinary acceptance suite retains recorded IR because v2 instructions prohibit
subprocess-dependent test rigs. ScriptC owns a tsgo subprocess, so the live runner
is explicit manual integration evidence, not hidden inside that suite. The runner
makes no model/network calls or production writes. Compiler scratch files and tsgo
are released before guest execution starts. This remains synchronous, bounded
experimental compilation; broader modules, syntax and sampling are not implied.

## Review hardening boundary

Admission now uses an explicit syntax allowlist and rejects unbound identifier
reads, including bare `eval`, optional host access, dynamic imports and type
assertions. It validates the entry as `(input: string, ctx: WorkflowContext):
Operation<string>` with the expected type imports before replacing that signature.
The helper must explicitly take and return strings. This is bounded signature
validation, not a general original-source TypeScript checker or a JS sandbox.
Remaining body types reach ScriptC; unsupported IR still fails projection.

The supported declaration profile is deliberately plain Zod `{ message: string }`
and a plain string response. Other shapes, refinements, transforms and alternative
schema providers reject rather than being guessed compatible. Fresh equivalent
plain schemas are allowed. Guidance uses the selected declarations and the same
profile check. Compilation still neither grants effects nor validates runtime
answers; those responsibilities remain with the host assembly.

The hosted acceptance journey composes the compiled artifact, real Scheme kernel,
checkpoint recovery, SQLite journal and existing effect grant/response validator.
A numeric response, missing effect grant and forged resolution grant all reject
without consuming the approval. After reopening, a valid answer advances to
cleanup; another reopen and answer complete with `approved:yes`. The compiler's
explicit direct-success policy stores the validated Outcome directly, rather than
using ToolContext's nested Outcome convention. This is in-process reopen evidence.
Ordinary acceptance projects hash-bound recorded ScriptC IR; the manual live probe
also covers the signature-erasure and host-reference regressions before a successful
subsequent compilation. Cleanup debug metadata now says `effect`.

The frontend remains experimental and is not exported as an executable public
package API. No additional target, serialized schema registry, cross-edit site-ID
promise or shared IR verifier was added.

## Registered caller and compiled callee slice

`linked.mjs` is a bounded experimental assembly, patterned after yo-workflow's
Execution prototype. It links one trusted compiler module to one public Scheme
entry, `review_draft`. The caller receives that entry, not the private `review`
definition or the capability instructions inside it. The module, caller, evaluator
identity and effect/source mapping contribute to the application program identity.
This is ordinary linking into one evaluator continuation, not textual macro expansion
and not an owned child journal. The shared `WorkflowModule` contract is unchanged.

```scheme
(define (workflow input)
  (let ((answer (review_draft input)))
    (if (equal? answer "approved:yes")
      (string-append "caller:" answer)
      "caller:declined")))
(workflow %input)
```

The compiled fixture still uses its bounded string reply protocol: it returns
`approved:<reply>` after cleanup. The caller interprets `yes` versus `no`; this is
not a complete sendEmail implementation or a promotion of that reply convention.

The linker parses and re-emits caller forms inside a host-owned registered-program
envelope and rejects internal evaluator forms. The existing v2 Scheme VM isolates
private definitions, protects registered names, and preserves nested call frames.
Compiler IR is trusted, verified frontend output; the limited definition-shape check
is not a general IR verifier. No raw host bindings, arbitrary module graph, package
linker API, provider, browser UI or evaluator-byte change is introduced here.

`inspectLinkedCheckpoint` projects a captured Scheme state into a detached diagnostic
view: caller/compiled calls, effect/source location, bounded environment displays,
pending cleanup completion, cancellation flag and evaluator step count. Closure bodies
are summarized. Captures carry the full program identity from capture/publication;
inspection rejects metadata-only artifact changes as well as changed executables.
Call attribution follows the evaluator registered-call scope, so colliding caller
names and private helpers remain distinguishable. This single-registration profile
does not support callbacks into caller code from compiled code. Inspection loads no VM and advances neither code nor journal state.
It is privileged diagnostic data; it must not be automatically disclosed to an
untrusted model or used as authority to answer, restore or invoke private code.

**Checkpoint versus observation:** the existing durable activation intentionally
clears/omits acceleration checkpoints under cancellation and uses replay to apply
cancellation at its recorded boundary. The acceptance assembly therefore uses
ordinary recovery middleware to capture diagnostics and retains a detached observation
only after the matching wait is successfully published, anchored to its journal
revision. The assembly is explicitly single-writer: commands reject overlap, and
inspection rejects reads while a command is active. External journal writers are
unsupported; request equality alone cannot bind diagnostics to concurrent changes
in cancellation state. Inspection uses that observation when no journal checkpoint exists. The
observation is never supplied to recovery. These diagnostics are local application
state; reopen coverage does not prove independent diagnostic persistence or atomic
publication across processes. If an observation is absent/stale, inspection must say
unavailable rather than start a Guest to reconstruct it implicitly.

`linked-workflow.acceptance.test.ts` exercises both host runtimes:

- Approval, decline, body cancellation and cleanup cancellation across SQLite reopen.
- Colliding caller/private helper names retain correct ownership after restore.
- Metadata-only remapping rejects old captures; busy commands/reads and absent/stale
  cancellation diagnostics reject without acquiring a Guest.
- Named caller and compiled callee visible at approval and cleanup source sites.
- Repeated reads and detached inspection mutation do not change evaluator/journal state.
- Fresh-machine restore and recapture preserve the exact continuation at both waits;
  normal hosting uses checkpoints, while cancelled hosting deliberately replays.
- Invalid responses and a source-site ID submitted as answer authority reject.
- Direct private entry/effect access, registered-name redefinition/shadowing, internal
  forms and missing grants reject; changed caller artifacts cannot restore old state.
- Completed/cancelled journal reads acquire no additional Guest.

The normal suite projects hash-bound recorded ScriptC IR. `run-live.mjs` additionally
compiles current authored TypeScript and runs the linked caller/inspection/restore
path on both runtimes, without recording a fixture. The original twelve direct
compile/restore journeys remain. Negative VM entry tests intentionally print Hoot
error diagnostics while asserting that no effect request escaped.

The next design questions are multi-module identity/source mapping, independent
persistence of diagnostic observations, and the standard sampling/decision authoring
contracts. Lua/Python parity and a general inspection API remain separate work. This
slice supplies no reason to add a new Guest, journal, scheduler or kernel primitive.

### Review follow-up: bounded caller and local recovery

The linker reserves the evaluator's `root` scope name. Caller numeric literals are
restricted to safe integers (excluding negative zero); exact fractions, decimal
and exponent spellings reject before parsing. Supported strings, including control
escapes, are exercised through the actual evaluator. This restricts model caller
authoring, not the trusted compiled module or checkpoint datum reader. The evaluator
remains responsible for full expression and protected-binding validation.

The [Cloudflare local demo](./cloudflare/README.md) now projects controls from the
journal's atomic pending request/interaction read and displays that request beside
its answer buttons. A separate explicit advancement command recovers retained
programs after interrupted execution without regenerating model code or replacing
uncertain effect attempts. Its assembly stays local to the experiment.
