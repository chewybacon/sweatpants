# Authored tools become acquired computations

The current boundary is definition → preparation → GuestWork → Guest → Turn.
The execution/journal loop receives computation capabilities, not an authoring
contract from which it must choose an implementation.

## Direct typed invocation

A concrete definition preserves its generator return type without `.output(...)`
or explicit result generics:

```ts
import { createDurableTool } from "@sweatpants/agent-sdk";
import { inProcess } from "@sweatpants/agent-host/server";
import { z } from "zod";

const double = createDurableTool("double", { version: "1" })
  .parameters(z.object({ value: z.number() }))
  .execute(function* ({ value }) {
    return { doubled: value * 2 };
  });

const prepared = inProcess().prepare(double, "direct");
const acquire = prepared.guest({ value: 21 }, "call-1");
// acquire returns GuestWork<{ doubled: number }, JournalRequest, ...>.
// After acquisition, guest.start() completes with that same result type.
```

This is invocation through placement, including when compute stays in-process.
The definition has no public `invoke`, callable body or `TOOL_BODY` member.
An explicit output schema remains optional for runtime validation/transformation.
TypeScript inference alone does not validate transported or persisted bytes.

Concrete `local` placement requires a versioned iterator definition and a worker
entry. Its prepare overload retains the same Result while native operations manage
the worker transport. `routeTools` preserves concrete preparation when its selected
adapters support it.

## Current chat call path

```text
createPrimitiveChatApp
  → execution.prepare(tools, "tools") / prepareChatExecution
  → activateChat
      → scoped effect bindings and placement setup
      → activateJournal
          → acquire createChatGuest(chatWork(..., bound invoke))
          → start / replay / resume
              → chatWork requests a registered tool
              → bound GuestWork acquires the selected tool Guest
              → child starts and yields JournalRequests
          → handleChatRequest
          → journal accepts Outcome
          → resume Guest, or park and close it
```

Preparation checks registry/route coverage. The invocation callback binds the
selected work before the chat cursor sees it. The private `invoke-tool` request
carries that work in memory; it is intercepted by `createChatGuest` and never
serialized as another journal protocol.

`createChatGuest` is a chat-specific composition adapter. Child completion uses
`Outcome<Json, Json>`, and authored failure is converted back into an Error for the
chat computation. It is not the universal execution model. Generic Guest and
`activateJournal` already provide the computation boundary.

## Responsibility and failure boundaries

- Tool compilation owns author schemas and request/reply typing.
- Admission owns lookup, interface checks and binding placement.
- Placement owns acquisition and transport; acquisition does not run the body.
- Guest owns continuation advancement and physical disposal.
- Handlers perform native work and return outcomes.
- The journal owns attempt/acceptance ordering and replay policy.
- The application owns authorization, commands, storage lifetime and projection.

Accepted raw answers replay through their authored schema boundary. Validation at
admission must not substitute transformed output for the raw accepted value and
thereby apply a transform again on replay. Concrete operation keys preserve reply
typing at authoring; the generic journal/wire boundary uses validated JSON.

Authored failures can be represented as completion data by the chat admission
wrapper. Lost workers and transport defects remain native failures; they must not
be accepted as ordinary tool-error results. Closing a parked Guest releases its
continuation. Replay reconstructs it from the beginning and feeds accepted outcomes;
it does not serialize a JS generator.

## Remaining compatibility

`routeTools`, `inProcess` and `local` still contain retained registry paths for
ToolSession resources and ProgramDriver assembly. `RetainedPreparedToolExecution`
exposes those capabilities explicitly. MCP also retains native-context execution.
The public iterator path is implemented; the whole framework has not been migrated.
Those adapters are compatibility boundaries, not a prescription for new author APIs.

Sources: [preparation](../packages/agent-host/src/primitive/activation.ts),
[chat cursor](../packages/agent-host/src/primitive/guest.ts),
[journal loop](../packages/primitive-journal/src/activation.ts),
[typed placement](../packages/tool-session/src/execution/tool-placement.ts),
[retained routing](../packages/tool-session/src/execution/placement.ts).
Evidence: [typed local/routed invocation and acquisition](../acceptance/__tests__/application-composition/yo-chat-worker.acceptance.test.ts),
[generic composition and transforms](../acceptance/__tests__/standard-durability/composition.acceptance.test.ts).
