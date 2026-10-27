# Runtime-portable chat activation

`@sweatpants/agent-host/primitive/activation` exposes the chat/journal execution
boundary. HTTP admission, authorization, projection and journal ownership remain
with the application host.

```ts
import { startChatActivation } from "@sweatpants/agent-host/primitive/activation";
import { runtime } from "@sweatpants/runtime-effection";
import { effection as composition } from "@sweatpants/standard-durability-effection";

const execution = startChatActivation(runtime, composition, capabilities, input, journal, {
  publish(event, request) {
    /* provisional model output */
  },
  accepted() {
    /* an outcome is now durably accepted */
  },
});
const activation = await execution.result; // completed or parked
// During execution: await execution.cancel();
```

`capabilities` supplies the model, tools and effect handlers. Its operations must
use the selected runtime's yielded protocol. Swapping the runtime also requires
matching native capability implementations; an Effection operation cannot be
executed by Effect.

The model contract is a stream consumer:

```ts
interface ChatModelStream<Y> {
  stream(
    request: ModelProviderStreamRequest,
    publish: (event: ModelStreamEvent) => void,
  ): IterableOperation<ModelResponse, Y>;
}
```

The implementation owns stream acquisition and cleanup, delivers provisional events,
and returns the final response. The journal accepts that final response before
resuming the guest. Publication does not establish HTTP backpressure or durability
of each streaming chunk.

Effect implementations can return `Effect.Effect<ModelResponse, never, R>`;
`createRuntime<R>(provide)` supplies their native requirements at execution.
When using the Effect composition adapter, provide its frame and native scope
with `effectProgram(() => work)` at that boundary (in addition to application
services); the bare default Effect runtime does not supply composition state.
Expected effect-handler failures are returned as `Outcome`, while defects and
interruption remain native runtime failures. The HKT `EffectRuntime` and
`EffectionRuntime` exports describe native computation types; Effection does not
statically track the error/environment slots.

The existing `createPrimitiveChatApp` uses the Effection adapter and preserves its
public configuration. Its model adapter owns a scoped subscription for each sample.
The full HTTP host and MCP application lifetime have not been made runtime generic.
There is no built-in Effect model-provider implementation in this slice; callers
of the portable activation supply one through `ChatModelStream`.

The caller owns the journal and must keep it open until `result` or `cancel()` has
settled. Disposing an activation is distinct from persisting a logical Stop command.

For scoped composition, `activateChat(composition, capabilities, input, journal, events)` returns
an iterable operation without starting another root runtime. This lets API/context
bindings remain visible to model handlers. `startChatActivation` delegates to this
same operation. The caller still owns the journal lifetime.

`execution: local({ worker })`, `inProcess()` and `routeTools(...)` select
per-tool placement using the existing execution adapter API. The host keeps the
chat loop, model requests, native effects and the single journal. Preparation
validates route coverage before admission; each activation runs the prepared
setup within its native scope. An omitted execution option uses in-process tools.

Prepared adapters supply `GuestWork` for each portable tool. Admission checks route
coverage and binds each model-selected call to that work. The host chat cursor
receives only the chat computation and bound acquisition requests; it does not
inspect definitions, choose implementations or look up placement. Acquisition
returns a Guest without advancing the authored body. The existing cursor then
starts/resumes that Guest, forwarding its requests unchanged to the journal. Internal invocation routing is not persisted as another protocol or
child journal. A parked tool closes; a fresh activation reconstructs its cursor
and feeds accepted outcomes. Tool completion uses `Outcome`; transport failures
escape instead of becoming accepted tool-error results. Worker entries use
`serveWorkerGuest` with `createToolGuest` from
`@sweatpants/tool-session/execution/tool-guest` for the registered tool. This narrow
admission wrapper preserves the inferred success result inside the chat completion
envelope; direct typed computations use `createIteratorGuest` and return their
inferred result without an envelope or mandatory output schema. The heterogeneous
chat registry intentionally erases results at model selection. Wire data still
requires runtime validation; inferred TypeScript results do not validate bytes.

`chatWork` consumes model metadata and a required invocation callback, with no
direct tool invocation fallback. The scoped model/API experiment uses the same
Guest composition path. The existing route validator now also binds admission
(`prepareChatExecution`); no additional execution loop is introduced.

Effect retry behavior comes from each declaration's `retrySafety.mode`. The journal
records an attempt before dispatch. If recovery finds no accepted outcome,
`repeatable` permits another dispatch; `unsafe` throws `outcome_unknown` without
calling the handler again. Accepted outcomes replay without dispatch under either
policy. This detects uncertainty, not whether the effect actually happened.

Concrete placement preserves the authored result without requiring `.output(...)`:

```ts
const count = createDurableTool("count", { version: "1" })
  .description("Count characters")
  .parameters(z.object({ text: z.string() }))
  .effects({})
  .elicits({})
  .execute(function* ({ text }) {
    return { count: text.length };
  });

const prepared = inProcess().prepare(count, "count");
const work = prepared.guest({ text: "hello" }, "call-1");
// Inside the owning runtime scope:
const guest = yield * work();
const turn = yield * guest.start();
if (turn.kind === "completed") {
  turn.value.count; // number
}
```

Here `createDurableTool` comes from `@sweatpants/agent-sdk`, `z` from `zod`,
and `inProcess` from `@sweatpants/agent-host/server`. Preparation and acquisition
leave the body untouched. Close the acquired Guest within its owning scope.
`local({ worker })` and typed-capable `routeTools(...)` support the same concrete
preparation shape. A worker must register the same versioned definition; its
transport does not turn inferred TypeScript types into runtime byte validation.
An optional output schema validates/transforms the authored return at compilation's
invocation boundary. Inputs remain the schema's raw input type until invocation.

Both builders compile to `ToolDefinition`, which exposes authored metadata and
preserves the inferred result. Authors pass that fluent product directly to
`makePlugin(tool)` or placement. No compiler token, body accessor or invocation
method appears on the definition. Direct invocation is in-process placement.

The compiler privately associates portable definitions with their implementation.
Existing native callable factories remain a runtime compatibility detail inside
native adapters, without a second public definition type. Native context setup
remains the native adapter's responsibility; concrete iterator placement currently
accepts portable definitions. Metadata projection excludes execution capabilities.
`ToolContract` and retained resource/driver protocols remain compatibility views;
they are not the journal's execution interface.
