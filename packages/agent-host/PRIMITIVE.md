# Experimental primitive chat host

`@sweatpants/agent-host/primitive` is an alternate production composition for a
single Node owner and a fresh SQLite database. The existing host is unchanged.
The normal React chat client and `makePlugin(tool)` use the existing HTTP protocol.

Author deterministic tools with `@sweatpants/agent-sdk/primitive`:

```ts
const approveRecord = createDurableTool("approve_record", { version: "1" })
  .description("Record a request, then ask whether to finish it")
  .parameters(z.object({ topic: z.string() }))
  .output(z.object({ receipt: z.string(), approved: z.boolean() }))
  .effects({
    record: {
      version: "1",
      input: z.object({ topic: z.string() }),
      output: z.object({ receipt: z.string() }),
      retrySafety: { mode: "unsafe" },
    },
  })
  .elicits({
    approve: {
      response: z.object({ approved: z.boolean() }),
      context: z.object({ receipt: z.string() }),
    },
  })
  .execute(function* ({ topic }, ctx) {
    const { receipt } = yield* ctx.effect("record", { topic });
    const answer = yield* ctx.elicit("approve", {
      message: "Recorded. Finish this request?",
      context: { receipt },
    });
    return { receipt, approved: answer.action === "accept" && answer.content.approved };
  });
```

Import `z` from `zod` and `createDurableTool` from the primitive SDK entrypoint.
The executable example is `acceptance/fixtures/approve-record.ts`; its React plugin
is beside it. Approval concerns completion, not authorization of the prior record.
Decline/cancel returns normally with `approved: false`.

```ts
import { call } from "effection";
import { success } from "@sweatpants/foundation/computation";
import { createPrimitiveChatApp } from "@sweatpants/agent-host/primitive";
import { serve } from "@sweatpants/agent-host/node";

const app = createPrimitiveChatApp({
  database: "/data/primitive-chat.sqlite",
  program: { id: "approval-chat", version: "1", digest: releaseDigest },
  model: { identity: modelConfigurationDigest, model, driver, streamOptions },
  tools: [approveRecord],
  authorize: (request, conversationId) => accessPolicy(request, conversationId),
  effects: {
    "approve_record.record": function* (input) {
      // The host supplies validated handler input.
      const args = input;
      const result = yield* call(() => externalService.record(args));
      return success(result);
    },
  },
});
const server = await serve(app, { hostname: "127.0.0.1", port: 3000 });
// On graceful shutdown: await server.close().
```

The caller supplies the provider driver, model and access policy. A trusted local
single-user deployment may authorize its loopback boundary. Client IDs and request
hashes are never credentials. The release digest must cover tools, deterministic
code and native effect behavior; model identity covers selected model settings
without storing credentials. Both must remain pinned when reopening the database.

One journal owns each turn: model responses, effects, elicitation answers,
notifications, tool results and nested samples. `chat.ts` runs the ten-iteration
model/tool loop; every call in a completed model response runs in causal order.
`createDurableTool` bodies compose with ordinary `yield*`. Arithmetic is computation,
not an effect. `context.sample` and `context.notify` yield into the same journal.
Native provider work uses `ModelProviderDriver.stream`; partial text, reasoning and
arguments are presentation, never permission to invoke a tool.

`activation.ts` reconstructs a fresh iterator Guest, accepts outcomes before resuming,
and dispatches only beyond the accepted prefix. Parking closes compute. The host
owns each running task and its subscribers separately: disconnect releases only the
subscriber; reconnect attaches to the live task without another provider call.
Completed tasks leave the owner map. Admission is serialized without holding a
provider wait; journal mutations are synchronous under the one process owner.

`store.ts` admits commands before execution and reconciles admitted answers and
interruptions after restart. Stop records its target before halting and joining
native work; only then does SQLite settle `cancelled`. Failed execution is `failed`,
not successful completion. An unsafe unaccepted attempt remains unresolved and
blocks dispatch. The stream reports `OUTCOME_UNKNOWN` with active authority; the
client preserves this diagnostic on reconnect. Known failure and cancellation
publish idle authority before their terminal error. Public identity conflicts are
rejected before admission; identical command retries use the admitted envelope.
A Stop receipt is only admission: first admission and identical retries join the
recorded target's owner and resolve its actual journal disposition. Unsafe
settlement refusal remains a refusal on retry. An old receipt after a later turn
returns current authority with `INTERRUPT_ALREADY_SETTLED`, without claiming that
the later turn was cancelled.

`disposition.ts` is the shared target-journal decision for execution, interruption,
recovery and terminal projection. Settlement runs only after native work joins (or
when recovery has no live owner); SQLite retains the unsafe-attempt guard.
Historical cached projections contain roots, never the next execution's failure.

`presentation.ts` derives windows from accepted outcomes and separate provisional
sample records. Sealed projections are durable derived records, not a completed
result map in application memory. Restart may retry an unaccepted sample; its
provisional content replaces the earlier attempt. Interrupted presentation remains
visible and labeled partial. Inference history contains only accepted, complete
call/result groups. A window contains at most 256 roots; older sealed roots are
available through the public history endpoint. There is no 32-turn conversation
limit. The journal remains the source of accepted results.

The default Node/local/SQLite yo-chat composition is
`apps/yo-chat/src/server/local-chat-application.ts`, selected by `chat-application.ts`.
It owns `/api/chat`, six direct tools, and separate thread metadata lifetime. Read
`tools/primitive/pick-card.ts` first, then `book-flight.ts` for two choices and nested
sampling. Remote/other-storage deployments still use the old host explicitly.
Neither the local branch nor a primitive tool invokes ProgramDriver or an ordinary
tool worker. Existing plugins share the same execution-neutral binding contracts.

Unsupported: multiple OS owners, remote ownership/fencing, old database or release
migration, arbitrary nonempty client state/context, regeneration, and child tool
frameworks. Native effects must declare repeatability honestly; uncertain unsafe
I/O has no automatic resolution policy. The demo effect handlers simulate search,
booking and randomness; they do not book real flights.

Native handlers own I/O and Effection resources. Tool bodies must not perform I/O,
read clocks/randomness, or retain resources. Synchronous iterator finalizers must
be bounded and must not yield. Graceful close stops admission, halts/joins native
work and closes the database; SIGKILL cannot run application finalizers.

External success is not journal acceptance. Death after I/O but before acceptance
leaves an unsafe attempt `outcome_unknown` and blocks dispatch. There is no claim of
exactly-once external execution. Repeatable sampling may repeat provider work and
billing if its result was not accepted. Accepted effects do not repeat on replay.

Read `acceptance/__tests__/host-crash/primitive-recovery.acceptance.test.tsx` for the
public crash story and `fixtures/primitive-host.ts` for host composition. The
shared process helper owns fork, SIGKILL, awaited exit and HTTP forwarding.

The fluent builder accepts synchronous Standard Schema V1 schemas. Pass explicit
`inputProjection` and `outputProjection` options to `.parameters()`/`.output()`
for non-Zod schemas; elicitation declarations use `responseProjections` and
`contextProjections`, and effects use `inputProjections`/`outputProjections`.
Missing projections reject at declaration time. Async validators reject at execution.
Effects and elicitation answers retain raw JSON outcomes in the journal; hosts
validate before acceptance, and resumed tool contexts transform those raw values.
This prevents applying a transform to an already transformed accepted outcome.
Repeated `.effects()` and `.elicits()` merge maps, with later keys replacing earlier ones.
