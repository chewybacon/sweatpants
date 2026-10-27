# Builder-first tool authoring

`tool-builder-authoring.ts` imports actual implementations. The ephemeral example
uses the existing SDK `createTool`; the durable example uses the new
`createDurableTool` from `@sweatpants/agent-sdk`. The prior parallel type-only
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

The portable builder now owns the root SDK `createDurableTool` export. The previous
crank builder is explicit at `@sweatpants/agent-sdk/legacy`; its remaining transports
and workflow/codemode consumers are not yet retired. The temporary `/primitive`
authoring export was removed. One internal compiler remains in
`tool/journal-compiler.ts`, without a builder import cycle.

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
The legacy builder’s typed context extensions (`uses`), richer sampling, document support,
decisions, explicit artifact identities and codemode are not implemented by this
builder yet. Those methods are absent rather than silently ignored. Do not treat
this subset as feature parity or label the crank builder retired.

The current ephemeral builder is still Effection-specific. Its migration to a
runtime adapter remains separate. Standard-durability core has no new runtime
or storage dependency from this work.

See the workspace completion report for current verification evidence.
