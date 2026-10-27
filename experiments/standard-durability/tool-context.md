# Tool context through installed capabilities

`executeBookFlight` is the real yo-chat flight-booking body. It still uses
`ctx.effect`, `ctx.elicit`, `ctx.sample`, and `ctx.notify`. Its context now has a
third type parameter, `Y`, describing the yielded protocol. Existing callers
retain `JournalRequest` as the default.

`createJournalToolContext(definition, callId, dispatch)` owns the existing request
construction, correlation, effect input/output validation and elicitation answer
validation. The fluent tool’s compiled `invoke` uses it with a handler that yields each
request to the journal. The old inline context construction was extracted, not
copied into a second implementation. Sampling retains its existing asserted reply
shape; this pass does not add runtime sampling validation.

`createToolContext(composition)` uses that same factory with a dispatcher over an
installed API. The host-facing signature is `ToolCapabilities`; implementations
satisfy `Operations<ToolCapabilities, Y>`. Effect and elicitation replies remain
unknown at this boundary because their schemas depend on the selected tool/key;
the context validates them before returning typed values to the author.

Application composition looks like this (with host implementations supplied by
the application):

```ts
function* booking() {
  return yield* effection.scoped(function* () {
    const tool = createToolContext(effection);
    yield* tool.Capabilities.install({ sample, elicit, effect, log, notify });
    yield* tool.Capabilities.around({
      *sample([request], next) {
        return yield* next({ ...request, maxTokens: Math.min(request.maxTokens, 200) });
      },
    });
    return yield* bookFlightTool.invokeWith(input, callId, tool.dispatch);
  });
}
```

The installation and middleware belong inside a caller-owned scope. Context
creation captures tool/call identity, while API invocation resolves installed
implementations in the executing scope. The exported `bookFlightWithCapabilities`
provides a callable composition that owns a child scope and installs the supplied
implementations. It can use either composition adapter when those implementations
use the corresponding yielded protocol.

This is a composition scaffold using the actual tool body, not a replacement for
the production chat activation. An installed elicitation implementation may wait
for a reply, but that alone does not persist a pending request or release compute.
The existing production journal route still owns acceptance, parking and replay.
Moving the native composition into that route requires a deliberate Guest bridge;
native effects must never be passed to its synchronous JSON iterator cursor.

Verification: focused TypeScript compilation with development package resolution.
No execution, tests, landing, or vendor calls were performed in this pass.
