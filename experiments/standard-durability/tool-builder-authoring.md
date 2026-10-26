# Builder-first tool authoring

`tool-builder-authoring.ts` imports actual implementations. The ephemeral example
uses the existing SDK `createTool`; the durable example uses the new
`createDurableTool` from `@sweatpants/agent-sdk/primitive`. The prior parallel type-only
builder contracts and hypothetical host interface have been removed.

The fluent authoring path remains familiar:

```ts
createDurableTool("book_flight", { version: "1" })
  .description("Book a flight")
  .parameters(parameters)
  .effects(effects)
  .elicits(elicits)
  .samples()
  .execute(function* (input, ctx) {
    // ctx.effect, ctx.elicit, ctx.sample, ctx.notify, ctx.log
  });
```

All six yo-chat local tools and all five yo-mcp tools use this builder. Their
bodies, schema declarations, request representation and declared versions remain
the same. The existing primitive chat host receives the resulting tool
through its existing tool list. No new host API or execution engine is required.

## Implementation and retirement

The new builder assembles the existing primitive tool compiler, which uses the
portable Operation/Handler contracts through foundation and yields journal
requests. This compiler validates tool inputs, effect inputs/results, elicitation
answers and JSON outputs. The host's journal supplies acceptance and replay; merely
constructing or manually iterating a tool does not make it durable.

The root SDK `createDurableTool` still constructs crank-backed programs for legacy
consumers. Its removal depends on migrating those consumers, including deferred
workflow/codemode support. The primitive subpath is a temporary import boundary,
not a third intended authoring model. Once its required surface and consumers have
moved, the primitive implementation should take the root name and the old compiler
should be deleted. The public object authoring API has been removed after
migrating every caller. One internal compiler remains in `tool/journal-compiler.ts`,
without a builder import cycle.

## Supported surface and remaining differences

This replacement currently implements description, parameters, output, effects,
elicits, samples and execute. Context capabilities are inferred from declarations;
undeclared sample/effect/elicit methods are absent in authored context types.
Effect and elicitation maps accumulate; later keys replace earlier declarations.
Output schemas constrain authored result types,
and the underlying compiler performs runtime validation and JSON capture.

It supports synchronous Standard Schema V1 with the existing portable projection
machinery for parameters, output, effects and elicitation response/context. Non-Zod
schemas require explicit input/output projections; asynchronous validators reject.
The root builder’s typed context extensions (`uses`), richer sampling, document support,
decisions, explicit artifact identities and codemode are not implemented by this
builder yet. Those methods are absent rather than silently ignored. Do not treat
this subset as feature parity or label the crank builder retired.

The current ephemeral builder is still Effection-specific. Its migration to a
runtime adapter remains separate. Standard-durability core has no new runtime
or storage dependency from this work.

Runtime verification is pending the integrated source freeze; see the workspace implementation report.
