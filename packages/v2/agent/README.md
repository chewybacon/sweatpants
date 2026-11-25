# Agent tool authoring

To call a private authored tool, grant the definition to its parent with
`.capabilities({ review: reviewClaim })`. In the parent generator, use
`yield* ctx.capabilities.review(claim)`. The standard recorded-chat binding
runs the direct child on its own journal and installs run effects in its scope.
Only tools in `defineAgent({ tools })` are published to the model. A child’s
pending elicit is discoverable through the chat’s normal interaction stream;
answer its execution and grant, then drive the chat again. The parent does not
forward answers. Use explicit tool routing for custom placement.

Use `defineAgent` to select an inventory for v2 recorded chat. It does not start a server, choose a workspace or install effects.

```ts
const searchFiles = defineEffect({
  key: "workspace.search",
  context: z.object({ pattern: z.string() }),
  response: z.array(z.string()),
});

const rg = defineTool("rg")
  .description("Find matching lines in the workspace.")
  .parameters(searchFiles.context)
  .capabilities({ search: searchFiles })
  .execute(function* (input, ctx) {
    return yield* ctx.capabilities.search(input);
  });

const agent = defineAgent({ tools: [rg] });
```

At definition time the agent projects each tool’s Zod **input** schema to JSON Schema. Duplicate names and conversion failures throw before a model request. The tool ID is the model name. Tool results are unchanged: the forwarding generator above returns the effect's `Outcome`. The chat program owns result formatting, history and program identity. Version its ID when changing the inventory or replay-visible behavior.

At run time, supply the existing chat program, runtime, admitted journal and sampling adapter. Bind again for a different run or a reopened journal.

```ts
const chat = agent.bind(runtime, program, {
  journal,
  sampling,
  *installEffects(effects) {
    yield* effects.install(searchFiles, function* ({ pattern }) {
      const lines = yield* runtime.fromPromise((signal) => search(workspace, pattern, signal));
      return { ok: true, value: lines };
    });
  },
});
```

The installer runs in each tool session’s host scope. Installation does not add a model tool. A generator can request only its granted capabilities; the adapter has no filesystem or shell fallback. Recorded chat still owns admission, execution and replay. Replaying an accepted outcome does not run the handler again. Acceptance does not guarantee exactly-once side effects before commit.

For custom evaluators, custom matching or model aliases, use `createChatToolBinding` directly. See `../acceptance/__tests__/applications/agent-tool-authoring.acceptance.test.ts` for public API examples, including recovery after a committed effect settlement.
