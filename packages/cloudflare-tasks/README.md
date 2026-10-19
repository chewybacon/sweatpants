# Cloudflare tasks

Run TypeScript seed and maintenance scripts with real Wrangler bindings from Node.
The runner loads bindings before importing your task or application modules, and
disposes the proxy after the task returns or throws. Return/await your work;
do not call `process.exit()` inside tasks.

```json
{ "scripts": { "task": "cf-task --config wrangler.jsonc --persist-to .wrangler/worker-state" } }
```

```ts
// scripts/seed.ts
import type { WranglerTask } from "@sweatpants/cloudflare-tasks";

export default (async ({ env, args }) => {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)")
    .bind("demo", args[0] ?? "Demo user")
    .run();
}) satisfies WranglerTask<Cloudflare.Env>;
```

Run `pnpm task scripts/seed.ts Alice`. Runner options precede the task path:
`cf-task --config wrangler.jsonc --env staging scripts/seed.ts Alice`.
Task arguments after the path are passed through unchanged, including flags.
Imports of `env` from `cloudflare:workers` in task dependencies also work.
Other Worker runtime exports are deliberately unavailable in Node tasks.

For programmatic callback access (this does not install the CLI import hook):

```ts
import { withWranglerEnv } from "@sweatpants/cloudflare-tasks";

await withWranglerEnv<Cloudflare.Env, void>(
  { config: "wrangler.jsonc", persistTo: ".wrangler/worker-state" },
  async (env) => {
    await env.DB.prepare("SELECT 1").first();
  },
);
```

`persistTo` means the same directory as Wrangler's `--persist-to` and the Vite
plugin's `persistState.path`. The package appends `/v3` for the proxy, so scripts
and the app use the same local D1 data. Relative paths resolve from the task's
working directory. Omit it for Wrangler's default `.wrangler/state` directory.

## Durable Objects

The proxy connects to a running local Worker; it does not load DO class code.
Run the Worker using Wrangler/Vite first and give each DO binding in the task
config a `script_name` matching that Worker's name:

```jsonc
{
  "name": "maintenance",
  "compatibility_date": "2026-10-05",
  "durable_objects": {
    "bindings": [{ "name": "COUNTERS", "class_name": "Counter", "script_name": "counter-worker" }],
  },
}
```

```ts
export default (async ({ env }) => {
  const counter = env.COUNTERS.get(env.COUNTERS.idFromName("demo"));
  await counter.fetch("https://counter/seed", { method: "POST", body: "10" });
}) satisfies WranglerTask<Cloudflare.Env>;
```

Use the DO's existing HTTP API. Cross-session DO RPC has Wrangler limitations;
this runner does not add an RPC bridge or expose raw DO storage.
See [Wrangler's supported bindings](https://developers.cloudflare.com/workers/wrangler/api/#supported-bindings).

Bindings are local by default even if the config marks resources remote.
`--remote-bindings` (or `remoteBindings: true`) enables only bindings already
configured with `remote: true`; it does not rewrite your config or turn all
resources into production resources. Durable Objects cannot be remote bindings.
Tasks execute in Node, so this is not a replacement for workerd app tests.
