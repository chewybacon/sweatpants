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

Tool acquisition remains provisional assembly in the acceptance application. No public
tool execution helper is provided yet. The application composes the scoped iterator, while its host owns admission, fresh grants, effect installation,
owned-child routing, recovery and physical disposal. Tool declarations do not grant
authority. Input must already be normalized and durably pinned by admission.

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
not a browser-safe bundle projection. Client splitting, root invocation persistence,
compiler restrictions and checkpointable tool bodies remain future work.

Acceptance journeys invoke tools through granted effects and owned journals on both
native runtimes, including placement middleware, recording, participant answers,
reopen/replay and scope cleanup. Source and emitted-declaration consumers check inference.
