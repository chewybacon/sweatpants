# A small chat application

Read `chat-app.ts` top to bottom. It composes the existing pieces without another
application framework. This example performs one text-only turn; no HTTP server,
UI toolkit, tools, multi-turn history or deployment migration is hidden in it.

```ts
import { run } from "effection";
import { chatApp } from "./chat-app.ts";

const task = run(() =>
  chatApp({
    database: "./chat.sqlite",
    turnId: "turn-1",
    text: "Explain scoped contexts in one paragraph.",
    model: { provider: "openai", id: "gpt-4o-mini" },
    write: (text) => process.stdout.write(text),
  }),
);

const result = await task;
// To interrupt from a UI/CLI controller: await task.halt();
// Display result.value as authoritative history when state === "completed".
```

Select a model available in your installed Pi model catalog and configure that
provider's credentials through the existing provider configuration. The example
above is a call-site illustration, not an automatic vendor call. We did not run it.
The database's parent directory must already exist.

## Follow the composition

1. `ModelDefinition` describes sample input, success/failure, version and retry policy.
2. `createScopedChat(effection)` supplies the scoped APIs. The application installs
   `createEffectionModelOperations(chat, provider.driver)` through `Model.host.install`.
   Its explicit `Operations<Signature<typeof ModelDefinition.operations>, EffectionYield>`
   contract allows another provider to supply the same methods. The implementation
   reads `ModelConfig` and calls `Output.operations.publish` per sample.
3. `Output.around` forwards provisional text to the app while preserving downstream
   middleware/sink behavior. It runs only during live provider execution.
4. `SqliteJournal` attaches persistence to this turn. The identity pins input,
   selection, temperature and application/model-contract version.
5. `chat.activate` runs the existing chat computation. Scope exit waits for native
   provider cleanup, then closes this application's journal.

Reuse the same database, turn ID, text and configuration to resume. Accepted work
is replayed without provider/output middleware calls. Completed reconnect therefore
returns the final value without streaming the answer again; the UI should display
that returned history. A new message needs a new turn ID. An accepted model failure
replays as the same error; this example has no reset/retry policy.

The configuration identity pins the selection and generation option declared here,
not the vendor's underlying model revision or external account configuration. Change
the application's version when changing authored semantics beyond those inputs.

## What this says about the public API

The authoring pieces are small and composable. The remaining friction is at the
composition root: it assembles turn input/identity manually and uses source-relative
imports for journal and application integrations. Those are concrete candidates for
an eventual application package, rather than reasons to add provider/storage concerns
to standard-durability core.

The caller chooses Effection because this native provider uses it. Portable declarations
and the core package retain no runtime dependency. An Effect-native provider would
supply its own native adapter while using the same declarations and capabilities.

Validation for this iteration: focused TypeScript compilation only. Landing and test
runs are paused at the user's request; no new acceptance suite or harness was added.
