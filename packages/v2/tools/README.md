# Tools

`defineTool` declares an ordinary callable effect with an evaluator-owned body.
Parameter schemas infer caller input and normalized body input; the body infers
its result. Capabilities and typed elicits use existing effect declarations.
Either declaration group can be omitted, and their order is unrestricted.

```ts
const investigate = defineTool("investigate")
  .parameters(querySchema)
  .capabilities({ readFile })
  .elicits({ clarification })
  .execute(function* (input, ctx) {
    const file = yield* ctx.capabilities.readFile(input.path);
    const answer = yield* ctx.elicit("clarification", "Include this file?");
    return { file, answer };
  });
```

## Hosted application entry point

`createToolApplication` assembles an authored tool into scoped `start`, `run`, `read`
and `answer` commands. It supplies local replay by default. Storage and compatible
placement remain explicit adapters; constructing the application starts no work.

```ts
const app = createToolApplication(runtime, investigate, {
  name: "investigations",
  matches: equalRequests,
  open: openJournal, // execution ID -> journal; register connection cleanup in this scope
  // recovery: selectedRecovery, // optional placement/checkpoint assembly
  *configure({ effects, acquisition, recovery, host }) {
    yield* effects.install(readFile, readFileHandler);
    yield* acquisition.around(traceAcquisition);
    yield* recovery.execution.around(traceAdvancement);
    yield* host.around(continuationBudget);
  },
});

// These operations inherit caller-installed ports, contexts and middleware.
const report = yield * app.operations.start(executionId, { path: "report.txt" });
const snapshot = yield * app.operations.read(executionId);
const receipt = yield * app.operations.answer(executionId, grant, outcome);
// Acceptance and advancement are deliberately separate, so a lost response can
// retry acceptance without changing the command. Run repairs interrupted advancement.
yield * app.operations.run(executionId);
```

`start` validates and pins normalized input before advancement; `run` recovers the
persisted input without repeating schema transforms. This includes admission pinned by
trusted lower-level journal code; that caller owns normalization. `run` repairs the gap
between admission and first advancement, not just previously started Guests.
`read` returns detached snapshot data, including the current interaction, without acquiring
a Guest. It omits connection-bound `history.at/read` methods; use a separately owned
journal scope for history access. `answer` validates against the original elicitation declaration and accepts
through the existing journal authority, without advancing. Results and input types stay
inferred; the grant-based answer envelope is validated at runtime against its stored
request. Concurrent writes retain existing journal conflict and duplicate-receipt rules.

The application itself is an ordinary `Api`: `around` and `install` operate on its
commands. Each command opens a journal inside an inherited child scope, checks its
execution/program identity, and uses `createToolSession`. The opener owns connection
acquisition and must register cleanup in that scope, including partial acquisition.
`configure` installs policy on the exact session instances used by that command,
after required admission, retention and default elicitation routing. It runs on reads
and answers too; keep installations lazy and do not invoke session commands recursively.
Default elicits park; `installElicitHandlers` can override them with server handlers.
Configuration failure, command failure and interruption unwind owned resources. A broken
configuration can therefore make reads unavailable too. Storage opens per command;
a convenience operation that starts then reads performs two independently owned opens.

There is no hidden `runtime.start`, global application scope, HTTP router, authorization
or scheduler. A framework adapter owns its native task and request signal. Applications
may own an outer scope for shared resources and inherited defaults. Authentication belongs
at the command boundary, including direct callers; request identity is transient and must
be re-established on recovery. Replay-relevant input belongs in admission. Native abort
stops local work; it does not record logical cancellation or undo accepted work.

`createToolSession` is the connection-bound assembly underneath. Each construction creates
independent capability instances. Every session command verifies the journal's program
before configuration or answer validation, including terminal runs. Its raw `read` retains
journal history readers and requires the caller's connection to stay open. It exposes admission,
effects, acquisition, recovery and host for advanced composition. It is also used by
`createChatToolBinding`; chat children supply their verified persisted parent link instead
of root admission. Child input must not be admitted again through `start`.

Placement factories must preserve pinned program and exchange semantics. Local scoped
installations do not cross a worker transport automatically. Remote bootstrap, grants,
codecs and checkpoint compatibility remain the adapter's responsibility; wrapping Guest
identity also requires preserving its checkpoint adapter. This application default is
native TypeScript, not an automatic compiler or sandbox selector.

The `tool-application` acceptance journey runs on Effect and Effection with local and
serialized-local placement. It checks inherited/overridden ports, acquisition/effect/Guest
middleware, normalized-input recovery, accepted-work replay and scope cleanup. The actual
Start `pick_card` handler adds SQLite connection disposal and duplicate-answer evidence.
These do not establish remote deployment or process-crash guarantees.

## Lower-level composition

`admitTool(runtime, tool, journal, rawInput)` validates a new root invocation and
atomically stores the schema's returned value with the journal's pinned program.
It does not acquire a Guest. Equal normalized resubmissions return the stored value;
conflicting input or program identity rejects, even after completion. Each new
submission validates; recovery instead reads `snapshot.admission.input` without
rerunning the schema. Concurrent validations may both run outside the transaction,
but only one normalized input can win. First admission must precede execution.
Owned children continue to pin input through `ensureChild`.

`createToolAcquisition(runtime, effects, tool, name)` supplies native acquisition
through an ordinary scoped API. Its `operations.acquire(normalizedInput)` creates a
fresh context and recording grant and wraps the body in the scoped evaluator. Input
must already be normalized and pinned by root admission or owned-child acquisition.
No input validation or journal writes occur during acquisition.

```ts
const acquisition = createToolAcquisition(runtime, effects, investigate, "investigate.acquire");
// Recovery consumes persisted normalized input:
const guest = yield * acquisition.operations.acquire(normalizedInput);
// Host assembly uses acquisition.handle and installs acquisition.admission before routing.
// Install effect handlers, participant delivery policy and Guest retention separately.
```

Acquisition grants the tool's declared capabilities, elicits and local recording.
Declarations alone still confer no authority. Capability and elicitation aliases
occupy separate namespaces. `handle` and `admission` resolve the current incarnation's
grant from its owning scope; using them after that scope exits fails. Each incarnation
needs its own scope. Native recorded callbacks require that scope to be retained
through delivery; `installGuestRetention` supplies that hosting policy.

The API supports acquisition middleware for observation and placement selection.
Wrapping `next(input)` preserves the native implementation. Replacing it is trusted
assembly and must provide compatible Guest lifetime and effect delivery; a wrapper
alone does not establish remote placement. The helper does not open journals, install
handlers, mount elicits, route owned calls, validate answers or run a session.

`ctx.scope` owns logical cleanup and critical regions.
`ctx.await(factory, { record: { key: "load" } })` is a convenience over the existing
record sandwich: grant the attempt, execute the Promise through the host runtime,
accept its value, and resume the body. Accepted values replay without executing the
factory. `{ record: {} }` selects positional identity. Unrecorded Promise execution
is deferred. `ctx.record(work, options?)` continues to record explicit outcomes.
Recorded Promise rejection is a delivery error, leaving its attempt unsettled.
Physical disposal discards the body; logical cancellation drains registered cleanup.
Arbitrary native yields and arbitrary finally unwinding on cancellation are not
supported by this evaluator.

The declaration exposes schemas, identity and typed interaction definitions as data,
but also retains executable bodies and possibly server handler dependencies. It is
not a browser-safe bundle projection. Client import splitting,
compiler restrictions and checkpointable tool bodies remain future work.

Acceptance journeys invoke tools through granted effects and owned journals on both
native runtimes, including placement middleware, recording, participant answers,
reopen/replay and scope cleanup. Source and emitted-declaration consumers check inference.

Root admission journeys cover invalid input without acquisition, duplicate/conflicting
submissions, transformed input across reopen, and a late validation racing a second
SQLite connection. These are in-process persistence journeys, not OS-crash evidence.

## Scoped elicitation delivery

`installElicitHandlers(host, effects, tool, handlers?)` selects delivery for the tool's
elicits. Supplied handlers execute through existing effect installation, receiving
normalized request context and returning an authored Outcome whose successful value
is response-schema input. Omitted handlers park through participant registration:

```ts
yield * installElicitHandlers(host, effects, investigate); // participant waits
// Or, in a child scope:
yield *
  installElicitHandlers(host, effects, investigate, {
    *clarification(context) {
      return { ok: true, value: "yes" };
    },
  });
```

Each installation defines policy for the entire declared elicitation set. An inner
installation can switch between automatic and participant delivery; scope exit restores
outer policy. Routing uses min middleware, so ordinary surrounding `host.around`
middleware can still wrap or bypass it. `effects.api(definition).around` composes
handler behavior as usual. Unrelated effects delegate unchanged.

This helper does not grant capabilities, install admission, present requests, or install
answer ingress. A participant host supplies interactions and uses `installEffectAnswers`
for later answers. Parked request context remains caller input; automatic handlers receive
schema output. Both paths normalize successful answers before recording them.

## Admission and routing assembly

`createToolAdmission(runtime, name, tool, journal)` binds `admitTool` as an ordinary
Api. Authorization and observation surround the whole operation; normalization and
atomic input pinning remain unchanged. Middleware runs per submission, including
duplicates. It does not implement exactly-once quotas or billing. Recovery uses
persisted input and does not readmit. Replacement drivers are trusted assembly.

Use `createToolAcquisition` for fresh grants, recording and tool-body assembly. Keep
its acquisition scope alive through delivery. `installToolRouting` installs one
named route on existing `Hosting.child`, reusing stored normalized child input on
recovery. Install parent grant admission before routing. Importing a definition does
not grant authority. Group routes still validate every descriptor before creating
any child; this helper does not replace group admission or child-host ownership.

## Typed public contract projection

`projectToolContract(tool)` returns a `ToolContract` for local interface consumers.
It preserves tool input/result inference, named capability and elicitation aliases,
context/response schema types, and domain `call` builders. A runtime whitelist excludes
the body, nested default implementations and extra authored fields. The new view,
its maps and nested effect views are shallow-frozen. Schemas and call functions retain
their original references; they are neither cloned nor deep-frozen.

```ts
const contract = projectToolContract(investigate);
// contract.call retains the tool's caller input and inferred result.
// contract.elicits.clarification retains its context and response schema types.
// contract.body and nested .implementation members do not exist.
```

Keep the original tool and effect objects for server acquisition, grants and handler
installation. The projected objects are distinct identities: registering them alongside
the originals under the same effect IDs conflicts. Projection installs nothing, grants
no authority and invokes neither schemas nor the tool. Result inference does not add
runtime result validation. The call builders still yield ordinary domain requests.

This is a local typed view, not a JSON descriptor, schema exporter, browser-safe module
or security sandbox. Importing a server definition before projecting it still imports
its dependencies; schema closures and call functions remain JavaScript. Portable model
metadata and build-time client imports need separate contracts and evidence.

The mounted-tool client journey now consumes only this view for interaction dispatch
and context validation. Wire context remains schema input; the client explicitly
validates it to handler context. It submits response-schema input, and server answer
ingress transforms that value before the Guest receives it. Original server defaults
and recording remain intact across SQLite reopen. Source and built-declaration fixtures
verify inferred tool results, capability failures and transformed elicitation types.

## Resolve a persisted tool execution

`resolveToolExecution(resolution, execution)` returns the original tool definition
and the child's `request` / `answer` interaction methods. It works without a live
Guest or current waiting frontier, including accepted-answer retries after completion.

```ts
const bound =
  yield *
  resolveToolExecution(
    {
      owner: parentJournal,
      programs: new Map([[investigate.id, investigate]]),
      // Trusted program contract; no batch history or execution projection is needed.
      bind: (execution, program) =>
        parentJournal.openChildInteractions<CapabilityRequest, unknown, string>(execution, program),
    },
    executionId,
  );
const request = yield * bound.interactions.request(resolutionGrant);
const granted = effects.grant(bound.tool.elicits);
const outcome = yield * granted.respond(request, { ok: true, value: rawAnswer });
const receipt = yield * bound.interactions.answer(resolutionGrant, { ok: true, value: outcome });
```

The resolver first opens the persisted direct child through the supplied owner and
selects a catalog entry using its stored program. Missing ownership or an unavailable
program rejects before `bind` runs. It then checks that the adapter returned the same
execution, parent and program before exposing ingress. Catalog definition types,
transport errors and runtime yield types are preserved.

The binder receives the verified program and supplies only an existing child link and
request/answer authority. `OwnedJournal.openChildInteractions` supplies this directly,
without scanning parent history or reattaching result projections. Chat uses this
binding; its group projection is installed separately when execution advances.
An existing `OwnedChild` also satisfies the binder contract. No recursive route is
supplied; the owner must be the target's direct parent.

The owner and catalog are trusted assembly inputs. Authorize the caller's access to
that owner separately; never take a program catalog or arbitrary owner capability from
a client. Use original compatible server definitions, not projected discovery objects.
Matching IDs cannot prove code-version compatibility, and checking an adapter's declared
identity cannot prove where its methods send writes. The binder must not create a
replacement execution, acquire a Guest or deliver effects.

The result is connection-bound. Rebuild the resolution wiring after reopening storage;
old methods do not follow a new connection. Resolution is not a lease or an atomic tree
snapshot. Answer acceptance must still recheck authority after validation suspends.
Host ingress middleware does not run implicitly on this direct path.

## Discover answerable tool interactions

`createToolInteractionStream(owner, rootReader, contracts)` exposes registered tool
questions as a read-only pull stream. Projected tool contracts supply the discovery
catalog; neither a Host nor an executable tool body is needed.

```ts
const contract = projectToolContract(investigate);
const questions =
  yield *
  createToolInteractionStream(runtime.composition, rootReader, new Map([[contract.id, contract]]));
const next = yield * questions.next();
if (!next.done) {
  const question = next.value;
  // Apply application visibility before rendering/encoding raw question.input.
  // question.declaration contains the context and optional response schemas.
  // question.grant identifies the stored interaction for separate answer ingress.
}
```

Each `ToolInteraction` retains execution/program identity, parent identity, revision,
exact grant, matching declaration, raw input, scope boundary and local cancellation
facts. Heterogeneous input remains `unknown`. Discovery does not parse context, execute
schemas, encode JSON Schema, grant answer authority or apply participant authorization.
Declarations and schemas are retained by reference; prefer projected contracts and
explicitly encode the fields intended for a client. This is not a safe wire envelope.

Only running nodes with registered waiting interactions are emitted. Their grants must
match the pending request, and their persisted program/effect must resolve to a declared
elicitation. Missing or inconsistent waiting contracts fail the stream. Multiple aliases
for one effect ID are allowed only when their context and response schema references
are identical; otherwise discovery fails as ambiguous. Equivalent aliases emit one
question using the first matching declaration. There is no structural schema comparison.
Keep the trusted catalog and its objects stable during traversal.

The stream is pull-only, with one subscription owned by the supplied scope. Repeated
acquisition and concurrent reads reject; owner exit invalidates the subscription and
releases traversal. No producer task, Guest or journal mutation occurs. Completion and
failures are retained; a failure after earlier values leaves only partial observations.
Create a fresh stream and reader after reopening storage.

Traversal follows the existing depth-first tree stream, reading separate snapshots.
An empty result does not establish completion: occupied, yielded and other non-waiting
work belongs in the execution view. Cancellation fields describe the observed journal,
not its ancestors or whole-tree status. Already-accepted answers disappear from discovery
even before advancement. A subsequently submitted answer must still pass current journal
authority checks; discovery is not a lease or an atomic frontier.

The chat journeys use this public stream for body and cleanup waits, visibility policy,
cancellation during cleanup, partial discovery failure and terminal reopen. They also
cover equivalent/conflicting aliases, repeat acquisition and owner exit. Lua's different
request protocol is not decoded by this authored-tool capability.

## Frontend elicit declarations and response APIs

`defineElicitPlugin(tool).onElicit(handlers)` declares a partial typed
frontend plugin. It projects the original tool internally and freezes the declaration,
handler map and support advertisement. It acquires no runtime or frontend resource.
Schemas and handler closures remain references; projection is still not browser import
splitting. Keep those captured dependencies compatible with retained work.

Frontend adapters declare their own capability vocabulary once:

```ts
const definePromptPlugin = defineElicitPlugins<PromptCapabilities>();
const plugin = definePromptPlugin(investigate).onElicit({
  *clarification(args, ctx) {
    const value = yield* ctx.prompt(args.context);
    return { ok: true, value };
  },
});
```

`args.context` is the elicit context schema's output. Successful handler replies are
response-schema input, preserving transformations at server answer ingress. The
handler's yielded protocol is inferred. `ctx.interaction` supplies immutable
execution/program, elicit alias, request and resolution identities. The alias remains
a literal type for each handler. Additional capabilities are frontend-defined; tools
has no React dependency and adds no universal render, progress or AbortSignal API.

Bind the same declaration independently for each frontend runtime/session:

```ts
const responder = createElicitResponder(
  runtime,
  "investigate.responses",
  plugin,
  (interaction) => ({ prompt: promptFor(interaction) }),
);

yield *
  responder.around({
    *respond(args, next) {
      const result = yield* next(...args);
      return result;
    },
  });
const outcome = yield * responder.operations.respond(retainedSelection, question);
```

This is an ordinary scoped Api. The default operation checks tool identity and client
route, validates raw question context, constructs frontend capabilities and invokes
the matching handler. Middleware surrounds the entire operation, including validation;
short-circuiting/replacement drivers are trusted and can bypass that default behavior.
Middleware selection occurs per invocation; the declaration and capability factory
are bound at responder construction. Use distinct API names for distinct responders
that share a scope. Handler work and any resources remain owned by the caller's scope.

No response is automatically sent to a server. The caller separately submits the
Outcome against the original grant, handles its receipt, arranges advancement and
refreshes the view. Discovery, compatibility and successful local handling grant no
answer authority and do not imply durable acceptance. Response schemas are validated
by existing server ingress, not transformed twice by the frontend.

## Select and install elicit coverage

Each tool must use a unique effect ID for every elicit alias when using plugins,
support selection or retained-route installation. These APIs reject duplicate IDs,
even when the aliases have identical schemas or routes: requests identify effects,
not aliases. This is a per-tool constraint, not a global registry. Higher-level
authoring tooling may generate namespaced IDs; these APIs do not rewrite identities.
Existing interaction discovery can still read equivalent aliases in older contracts.

`selectToolSupport(permitted, advertised)` is a pure helper over decoded inputs. It
requires coverage for every declared elicit and returns immutable `available` selections
and `unavailable` entries with missing aliases. It never expands the server's permitted
inventory from client advertisements. Declared server handlers take precedence; tools
without elicits need no client support. Authorization, choosing the server inventory,
wire decoding/limits and compatible tool definitions remain application responsibilities.
The helper checks claimed support, not actual connectivity or handler liveness.

```ts
const selected = selectToolSupport([{ tool: investigate, server: [] }], [plugin.support]);
// Persist selected.available with the admitted execution, then bind its tool catalog.
```

`ElicitSupport` and `ElicitSelection` are schema-independent coverage contracts. They
identify tools and elicit aliases, not schema compatibility. No separate revision label
or generated compatibility proof is supplied. Keep declarations compatible with retained
work; incompatible authored changes require distinct program/tool identities. Decode wire
advertisements before selection. Retain selected routes with admitted work and rebuild
from them; reconnect does not authorize changing the handling policy of existing work.
The existing admission input supplies this persistence—no separate registry is created.

`installSelectedElicitHandlers(host, effects, tool, selection, handlers?)`
applies that retained plan through `installElicitHandlers`. It checks matching
tool identity, complete known routes and supplied functions for every server route
before installing anything. Client routes park even if an unselected server handler
was supplied. This middleware owns neither journal persistence nor response acceptance;
install original server declarations with the ordinary hosting/grant assembly.

The flight acceptance journey uses these package exports with real chat/tool hosting,
SQLite and React on both runtimes. It demonstrates one declaration bound to distinct
capability instances, scoped response middleware isolation, invalid context rejection,
missing server-handler rejection, client-route preservation, reopen and exact-grant
answering. Source/emitted checks preserve typed context, capabilities and responses.
The retired chat-prototype HTTP acceptance journey consumes the same implementation. React presentation and
the application-owned snapshot/handler dispatcher remain app-local, as do retries,
frontend session replacement and multi-tab ownership policy.
