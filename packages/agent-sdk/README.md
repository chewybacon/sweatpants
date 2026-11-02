# Tool authoring

Import `createTool` (ordinary native execution) and `createDurableTool` (portable
journal execution) from `@sweatpants/agent-sdk`. The temporary `/primitive`
authoring export has been removed.

```ts
const tool = createDurableTool("double", { version: "1" })
  .description("Double a value")
  .parameters(z.object({ value: z.number() }))
  .effects({
    double: {
      version: "1",
      input: z.number(),
      output: z.number(),
      retrySafety: { mode: "repeatable" },
    },
  })
  .execute(function* (input, ctx) {
    return { value: yield* ctx.effect("double", input.value) };
  });
```

The builder preserves the name literal, parameter and capability types, and body
result. An explicit output schema constrains the body's raw return value; the
compiled invocation returns its validated, transformed output. Effects and elicits
retain their exact keys. `makePlugin(tool)` derives the client interaction types.

Native effect registration derives handler types from the same tool definitions:

```ts
const Effects = createToolEffects(effection);
const handlers = Effects.handlers([tool])({
  *"double.double"(value) {
    return success(value * 2);
  },
});
```

The first call fixes the declarations before contextual typing of the handlers.
Handlers receive canonical input and return raw output. The existing validation
middleware checks that output while the journal accepts the raw outcome; the guest
applies its output transform after resumption. Use the resulting handler map with
the journal-capable host's `effects` option.

`tool.invoke(rawInput, callId)` yields serializable journal requests.
`tool.invokeWith(rawInput, callId, dispatch)` runs the same inferred body through
caller-owned native capabilities, with the dispatcher's yielded protocol. The
latter is an adapter boundary: it does not add persistence, retries or a runtime
root. The caller owns capability installation and cleanup. Ordinary ToolSession
answers must be projected to the action/content envelope rather than returning
their live exchange objects. Native I/O is rejected in the portable body type;
it belongs in the installed handlers.

`execution: "journal"` distinguishes these definitions from callable ordinary
tools and retained crank programs. Discovery exposes `journalTools` separately;
it never inserts them into an ordinary worker or crank manifest registry.

## Retained transports

The previous builder is explicitly available from `@sweatpants/agent-sdk/legacy`.
Existing crank transports and deferred workflow/codemode consumers still use it.
The new root builder does not yet implement its `.uses()`, `.decisions()`, document
bindings, richer sampling or artifact-identity options. This is an explicit
transition boundary, not a claim that the old execution engine has been retired.

yo-chat's six retained tools now adapt their capabilities to the same portable
bodies used locally. Card and game retain their effect/retry/transport policies;
their implementation digests were updated for the new bodies. The ordinary
tic-tac-toe adapter now forwards the shared body's diagnostic progress messages.
