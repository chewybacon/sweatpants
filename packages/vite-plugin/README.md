# Sweatpants Vite integration

`frameworkPlugin()` includes client contract compilation, optional tool discovery,
and automatic portable workflow compilation. Use `tools: false` when your app
already authors explicit tool lists; workflow compilation still applies.

```ts
import { defineConfig } from "vite";
import { frameworkPlugin } from "@sweatpants/vite-plugin";

export default defineConfig({
  plugins: [frameworkPlugin({ tools: false })],
});
```

Add a directive to an ordinary SDK tool and import it normally:

```ts
import { createDurableTool } from "@sweatpants/agent-sdk/tool";
import { z } from "zod";

export const review = createDurableTool("review", { version: "1" })
  .description("Review a title")
  .parameters(z.object({ title: z.string() }))
  .output(z.string())
  .elicits({ approval: { response: z.object({ approved: z.boolean() }) } })
  .execute(function* (input, ctx) {
    "use workflow";
    const reply = yield* ctx.elicit("approval", { message: input.title });
    if (reply.action === "accept") {
      if (reply.content.approved) {
        return "approved";
      }
    }
    return "declined";
  });
```

Vite attaches Scheme and Lua artifacts to this tool without replacing its ordinary
SDK implementation. There is no artifact import or separate compilation command.
The Execution integration selects the artifact through
`getCompiledWorkflow(tool, language)` from
`@sweatpants/flowmode-runtime/compiled-tool`.

`workflowPlugin()` is separately available for explicitly composed integrations
such as Astro. It uses the same transform for development and production, watches
local type dependencies, emits source-located diagnostics and lets Vite invalidate
modules on edits. It resolves its lightweight runtime helper from its own package;
applications do not need an extra dependency simply to use the directive.

Compilation uses a bounded portable subset. Unsupported source fails compilation;
it never falls back to a stale artifact. See the
[compiler contract](../flowmode-compiler/README.md) for supported declarations and
syntax. Live continuation migration is not supported. Execution requires a new
run when persisted code identity differs after rebuilding.

Advanced build-tool consumers can use the compiler packages directly.
`workflowArtifactPlugin(declarations, { compiler })` emits standalone portable
artifacts and inferred declarations for Rolldown/tsdown builds. This explicit
artifact surface remains distinct from the SDK export.

`nodeWorkerPlugin` remains necessary for `?modulePath` worker resolution. Workflow
compilation does not introduce a different worker or program-driver lifecycle.
