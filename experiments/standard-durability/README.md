# standard-durability: scoped composition scaffold

Design experiment, not a standard or production migration. Start with the authoring
experience in `conversation.ts`, then read `contracts.ts`. No storage, scheduler,
worker protocol or durable execution API is invented here.

## Reading order

- `contracts.ts`: dependency-free structural types for operations, APIs, contexts,
  middleware, and scoped resource ownership.
- `conversation.ts`: a runtime-generic framework module. One factory assembles its
  declarations; deeply nested calls use contexts rather than forwarding services.
- `effection.ts`: reference adapter over native Effection createApi and scope APIs.
- `effection-example.ts`: callable example with primary and child model bindings.
- `effect.ts`: Effect adapter using native resource scopes and a parent-linked
  binding environment. `effectProgram(work)` supplies its root lifetime.
- `effect-adapter.md`: implementation decisions and remaining boundaries.

The existing `packages/runtime-effect` adapter executes iterable work. For this
experiment use `Effect.runPromise(effectProgram(work))` so the composition bindings
and native resource scope are installed. No production API has been migrated.

## Authoring shape

```ts
interface Model {
  sample(prompt: string): string;
  countTokens(text: string): number;
}

const Model = composition.createApi<Model>("example:model", {
  *sample() {
    throw new Error("Model not installed");
  },
  *countTokens() {
    throw new Error("Model not installed");
  },
});

// These declarations belong to the framework module, assembled once.
// Installation belongs to an executing application/conversation scope.
yield * Model.install(provider);
yield *
  Model.around({
    *sample(args, next) {
      const result = yield* next(...args);
      return result.toUpperCase();
    },
  });
const answer = yield * Model.operations.sample("Hello"); // string
```

`Model` is a signature description, not an object of synchronously implemented
methods. `Operations<Model, Y>` maps it to operations in the selected runtime.
Argument tuples, method-specific results and middleware next results stay correlated.
This scaffold intentionally starts with non-overloaded, non-generic API methods;
conditional types do not faithfully lift arbitrary overloaded/generic signatures.

The adapter is supplied once to `createConversation(composition)`. This creates
stable API/context declarations for that framework instance. Calling it again
creates a separate facade; names must be unique among unrelated declarations in
one scope tree, matching native Effection's name-based context lookup.

## Proposed semantics, using Effection as the reference

- Plain `yield*` shares the caller's scope. `scoped` creates a child owner.
- Context lookup uses the executing scope; child assignments leave parents intact.
- An API facade, or an unstarted operation, does not capture its creation scope.
- Middleware inherits. Default/max middleware surrounds terminal/min drivers.
  Earlier/ancestor max middleware surrounds later/descendant max middleware;
  later/descendant min middleware surrounds earlier/ancestor min middleware.
- Driver installation is terminal, exactly once per scope. Children may override.
  All API calls still go through middleware; context access must not hand out a raw
  driver as a way to evade it.
- `ensure` registers cleanup in the caller's scope. Child cleanup finishes before
  the parent resumes after `scoped`. Native cleanup-error behavior still needs
  comparison; this sketch does not promise portable multi-error aggregation.
- No foreign-scope binding or raw scope destruction is exposed yet. These require
  explicit ownership semantics and are unnecessary for this example.

Example results, now checked against both runtimes:

1. `primary: acme: Hello`
2. `alternate: preview: Hello from the child`
3. `primary: acme: Hello again`

Parent middleware should surround all three calls. The child cleanup precedes the
third call, and application cleanup precedes overall completion.

## Durability boundary

This composition contract is useful beneath durability; it does not establish it.
Contexts and middleware installations are reconstructed, not automatically stored.
Live handler middleware transforms the outcome before acceptance. Replaying an
accepted outcome must not execute that live handler again. Replay observation is
a distinct hook. Native disposal is distinct from a persisted logical Stop.

An open design question is which bindings need pinned identity when they affect
request reconstruction. No implicit serialization of contexts is proposed.

## Status and limits

The scaffold typechecks independently with:

    pnpm exec tsc -p experiments/standard-durability/tsconfig.json

The existing acceptance runner now exercises six scenarios under each runtime
(12 focused cases passed): authored conversation, late parent changes/sibling
isolation, min/max order, missing/duplicate configuration, cancellation awaiting
asynchronous child cleanup, and failure cleanup. See
`acceptance/__tests__/standard-durability/composition.acceptance.test.ts`.

The Effection bridge contains two localized assertions: conditional mapped-type
normalization and dynamic construction of terminal middleware. Public signatures
retain their exact argument/result mapping.

`Operation` and `Work` structurally mirror foundation for this isolated sketch.
Before promotion, extract one canonical dependency-free package and have foundation
re-export it; do not maintain competing production definitions. Nothing here
changes the production API or claims full Effect error/environment inference.

Portable cleanup uses `composition.ensure`. JavaScript generator `finally` around
a native suspension is not specified as a cross-runtime cancellation finalizer.
Native error channels remain native; use explicit Outcome values for portable
expected failures rather than assume JavaScript catch intercepts native failures.

## Scoped model API on the production chat activation

`chat.ts` defines `createScopedChat(composition)`, which binds model sampling through
createApi while calling the production `activateChat` operation. `startChatActivation`
uses that same operation for the existing HTTP host. There is no second chat loop.

```ts
const chat = createScopedChat(composition);

yield * chat.Model.install(provider);
yield *
  chat.Model.around({
    *sample(args, next) {
      const response = yield* next(...args);
      return transform(response);
    },
  });
return yield * chat.activate(capabilities, input, journal);
```

Each live model sample owns a child scope. The provider and middleware can acquire
native resources there. Cleanup finishes before the final transformed response is
accepted. Streaming publication remains provisional. Replay bypasses the sampling
API entirely for accepted outcomes, so middleware must not be relied upon for
replay observation.

`chat.acceptance.test.ts` adds three shared stories under both runtimes:

- sample and invoke the real authored approve-record tool, park for its answer,
  close/reopen SQLite, complete, then reconnect without repeating accepted model
  work, middleware, or the unsafe record effect;
- interrupt after acceptance and before guest delivery, reopen SQLite, and recover
  the transformed response without calling the provider again;
- dispose during a streaming sample, wait for asynchronous resource cleanup, and
  leave provisional output unaccepted and the logical execution still running.

These use scripted model responses with native runtime suspension. They exercise
production chat/tool/journal code, not a live model vendor or an Effect HTTP host.
Recovery uses fresh scope bindings and reopened SQLite handles in one process;
there is no new SIGKILL or cross-process claim. The fault after acceptance is an
explicit injected exception. Existing full-suite crash tests remain regression
coverage for the production Effection host.
