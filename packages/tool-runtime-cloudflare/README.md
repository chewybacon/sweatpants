# Cloudflare tool execution

Runs journal-backed tools in Dynamic Workers or Durable Objects behind the existing
`ToolExecutionAdapter` / `ProgramDriver` contracts. The host owns the journal,
effect resolution and activation fencing. The executor owns only a live generator.

## Durable Object placement

```ts
import { createToolExecutorObject } from "@sweatpants/tool-runtime-cloudflare/executor";

export const ToolExecutors = createToolExecutorObject({ tools: [pickCard] });

// Host setup, with a TOOL_EXECUTORS namespace bound to the exported class:
const execution = cloudflare({ executors: env.TOOL_EXECUTORS });
// Mixed inventory:
const mixed = cloudflare({ executors: env.TOOL_EXECUTORS, sessions: env.TOOL_SESSIONS });
```

Register `ToolExecutors` with a `new_sqlite_classes` Wrangler migration and bind
its namespace. Each activation selects a fresh DO and receives its own RPC target.
The same executor protocol handles attach, step and shutdown in both placements.
The DO stores no journal and does not keep a parked generator: park closes the
attachment, and the next request replays from the host journal. Ordinary tool
sessions keep their separate live-session semantics.

Choose either `executors` or `worker` for durable placement. DO placement does not
require a Worker Loader or runtime bundling. It runs statically deployed trusted
code with the DO's configured bindings and network access; it does not provide the
Dynamic Worker's `globalOutbound: null` sandbox.

## Execution services

Both executor factories accept an optional `setup: () => Operation<void>`. The
executor runs it inside each program's owned Effection scope, before the program
starts. Install ports and acquire scope-owned resources there. Ingress setup does
not cross the RPC boundary. Setup runs again on replay; scope exit releases its
resources on parking, completion, cancellation, or failure. Setup failures fail
the program rather than falling back to another placement.

For example, yo-workflow installs its bounded evaluation driver in the tool-executor
DO this way. No journal or effect-dispatch ownership moves into that driver.

## Dynamic Worker placement

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
