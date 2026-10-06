# Cloudflare tool execution

Runs journal-backed tools in Dynamic Workers behind the existing
`ToolExecutionAdapter` / `ProgramDriver` contracts. The host owns the journal,
effect resolution and activation fencing. The executor owns only a live generator.

The dynamically loaded module exports an executor for its pinned tool inventory:

```ts
import { createToolExecutor } from "@sweatpants/tool-runtime-cloudflare/executor";
import { pickCard } from "./tools/pick-card";

export default createToolExecutor({ tools: [pickCard] });
```

Bundle this entry into a Worker module. In the host's active request, load the
bundle through a Worker Loader binding and select the adapter:

```ts
import { cloudflare } from "@sweatpants/tool-runtime-cloudflare";
import type { ToolExecutorClass } from "@sweatpants/tool-runtime-cloudflare/executor";

const worker = env.LOADER.get(bundleDigest, () => ({
    compatibilityDate: "2026-10-05",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "executor.js",
    modules: { "executor.js": bundledSource },
    globalOutbound: null,
}));
const execution = cloudflare({
    worker: worker.getEntrypoint<InstanceType<ToolExecutorClass>>(),
});
```

Configure `worker_loaders: [{ binding: "LOADER" }]` on the host Worker.
A cached loader ID must identify immutable code and configuration. `load(code)`
can instead create a fresh Worker without caching. Neither requires a DO binding.

Each attachment is a returned `RpcTarget`. All `attach`, `step` and `shutdown`
calls use that target, rather than assuming separate entrypoint calls reach the
same isolate. Keep it within the owning request's execution context. The adapter
closes the generator and disposes the stub on park, completion or scope exit;
a native RPC disposer also schedules cleanup if the caller releases its target.
A failed cleanup is observable as a rejected workerd `waitUntil` task.

A parked turn does not retain a generator. The next request creates a new target
and replays from the host journal. Recorded effect results are reused. Losing a
Worker or a request does not itself decide the durable outcome: journal policy
still governs retries, cancellation and indeterminate effects.

## Ordinary multi-turn tools

Export a Durable Object class with the same authored `createTool` definitions:

```ts
import { createToolSessions } from "@sweatpants/tool-runtime-cloudflare/sessions";
import { bookFlight } from "./tools/book-flight";

export const ToolSessions = createToolSessions({ tools: [bookFlight] });
```

Bind this class as `TOOL_SESSIONS` (a SQLite-backed DO namespace), then select:

```ts
const execution = cloudflare({ sessions: env.TOOL_SESSIONS });
// A mixed inventory supplies both worker and sessions to the same adapter.
```

One named DO owns each invocation's Effection scope, live generator and replayable
projection. Host requests pull events by cursor; ending a reader cancels its pending
RPC without cancelling the tool. Subsequent elicitation and sampling responses
resume that same generator. The existing invocation host owns command validation.

A storage alarm bounds the invocation's lifetime to ten minutes by default;
`maxLifetimeMs` can lower that limit. `waitUntil` retains the owner while it is
waiting, and explicit disposal or the alarm closes the scope. This is live session
placement, not journal replay: eviction, restart or expiry returns
`tool_session_lost`. A stored invocation identity prevents re-executing ordinary
side effects after compute loss. Use durable tools when recovery is required.

Cloudflare journal storage and moving all of yo-chat into workerd are separate work.

Validation:

- Real Miniflare/workerd tests cover native request-scoped RPC, replay without
  repeating settled effects, cancellation, malformed commands and cleanup.
- yo-chat's pick-card acceptance scenario destroys the entire workerd process
  while parked, reconnects, answers the recovered picker and completes the same
  turn before admitting another message, through both in-process and HTTP ingress.
- Node-hosted tests use an explicit bridge for Miniflare's missing symbol-method
  forwarding. Native request tests exercise `Symbol.dispose` directly in workerd.

These are local runtime checks, not a live Cloudflare deployment certification.
