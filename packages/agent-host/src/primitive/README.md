# Runtime-portable chat activation

`@sweatpants/agent-host/primitive/activation` exposes the chat/journal execution
boundary. HTTP admission, authorization, projection and journal ownership remain
with the application host.

```ts
import { startChatActivation } from "@sweatpants/agent-host/primitive/activation";
import { runtime } from "@sweatpants/runtime-effect";
// Or: import { runtime } from "@sweatpants/runtime-effection";

const execution = startChatActivation(runtime, capabilities, input, journal, {
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

For scoped composition, `activateChat(capabilities, input, journal, events)` returns
an iterable operation without starting another root runtime. This lets API/context
bindings remain visible to model handlers. `startChatActivation` delegates to this
same operation. The caller still owns the journal lifetime.
