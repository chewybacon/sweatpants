# Agent tool authoring

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
