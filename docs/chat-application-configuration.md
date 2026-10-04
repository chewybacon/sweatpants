# Configuring chat applications

`createChatApp` from `@sweatpants/agent-host/server` is the entry point for
building a durable chat application. One call produces the application
lifecycle (lazy setup, request handling, graceful close) and the route
endpoints, with an explicit authority storage choice.

## Quick start

```ts
import { chatStorageFromEnv, createChatApp } from "@sweatpants/agent-host/server";
import { local } from "@sweatpants/tool-runtime-local";
import { pi } from "@sweatpants/model-provider-pi-ai";
import { tools } from "./tools";
import { effects } from "./effects";
import worker from "./tools.worker.ts?modulePath";
import durableWorker from "./programs.worker.ts?modulePath";

export const app = createChatApp({
  name: "my-app",
  secret: process.env.MY_APP_SECRET!,
  storage: chatStorageFromEnv({ defaultPath: new URL("../.data/app.sqlite", import.meta.url) }),
  model: pi({ provider: "github-copilot", model: "claude-sonnet-4.6" }),
  tools,
  effects,
  execution: local({ worker, durableWorker, isDev: true }),
  setup: {
    application: installApplicationServices,
    chat: installChatServices,
  },
});
```

Mount its base path and catch-all route under any framework using Web Requests:

```ts
// /api/chat and /api/chat/* — framework route exports
export const GET = app.handler;
export const POST = app.handler;

// Graceful shutdown drains work and closes app-owned storage.
await app.close();
```

`basePath` defaults to `/api/chat`. The handler owns this route family:

| Method | Path | Operation |
|---|---|---|
| POST | `/api/chat` | submit a chat command |
| GET or POST | `/api/chat/:conversationId` | hydrate/reconnect |
| POST | `/api/chat/:conversationId/history:page` | page archived history |

GET reconnect accepts `x-known-window-token`; POST reconnect accepts the native
reconnect body. Conversation IDs are decoded once from a single URL segment.
Unknown paths return 404; unsupported methods return 405 with `Allow`.
A trailing slash is accepted. Routing failures do not initialize the application.
If your framework requires separate base and catch-all route files, both forward
to the same handler. Point the chat client's `api` option at the configured base path.

## Direct server API

```ts
const streamResponse = await app.api.postChat({
  headers: request.headers,
  signal: request.signal,
  body: command, // typed native ChatPostBody
});

const reconnectResponse = await app.api.readChat({
  headers: request.headers,
  body: { conversationId, clientId },
});

const page = await app.api.pageHistory({
  headers: request.headers,
  body: { conversationId, cursor },
});
// page.roots, page.nextOlderCursor

const response = await app.api.pageHistory({
  headers: request.headers,
  body: { conversationId, cursor },
  asResponse: true,
});
```

Direct calls use the same handler, validation, authorization, and application scope;
no HTTP fetch is made. Credentials must be forwarded explicitly. `baseURL` supplies
the origin of these internally constructed requests (default `http://sweatpants.local`);
set it to your public origin when authorization or setup examines the request URL.
It accepts an HTTP(S) origin only; route placement belongs to `basePath`.

`postChat` and `readChat` return a live `Response`, including HTTP error statuses.
Consume or cancel its body; Sweatpants does not buffer the stream. Passing `signal`
propagates cancellation to the request. History calls return `PublicHistoryPage`
and throw `ChatApiError` with `status`, `body`, and `headers` on failure.
`asResponse: true` returns the original history response, including error statuses.
All calls after close reject with `ChatApplicationClosedError`.

`name` and `secret` derive signing keys; `tools` derives the inventory, durable
program registration, and journal schemas. `storage` selects authority storage.

## Tools and execution

Use one list containing both `createTool()` and `createDurableTool()` definitions.
Ordinary tools remain ordinary; durable tools retain their pinned program identity,
replay, effects, and explicit nested tool capabilities. Registration does not grant
nested agents access to every tool. Their authored capability declarations still apply.

`local({ worker, durableWorker })` uses the existing worker-backed invocation host
and durable worker driver. Supply `worker` when there are ordinary tools and
`durableWorker` when there are durable tools. URLs are explicit: the library does
not serialize closures or silently execute tools in process. Vite's
`nodeWorkerPlugin()` supports `?modulePath`; other builds can supply built file URLs.
`isDev` and `execArgv` configure the ordinary worker loader.

Opt into retaining durable workers with `local({ worker, durableWorker,
idleTimeoutMs: 60_000 })`. The default is `0` (no retention). At a durable park,
the generator attachment still closes. An idle worker can accept a fresh
attachment and replay its journal; the live generator is never cached across
parks. Idle expiry and application shutdown terminate retained workers. Active
attachments are not subject to the idle timeout, concurrent attachments use
separate workers, and terminal or failed attachments discard their worker.
This setting does not change ordinary tool-session lifetimes.

Custom hosts acquire the resource with `yield* useLocalWorkerDurableProgramDriver`
in their application scope. Its optional `onWorkerError` callback observes worker
failures (otherwise logged); failures reach active callers and failed workers are
removed from the pool. This does not automatically retry an interrupted activation.

Both worker entries derive their definitions from the same list:

```ts
// tools.worker.ts
import { runToolWorkerEntry } from "@sweatpants/tool-runtime-local/worker";
import { tools } from "./tools";
await runToolWorkerEntry(tools.filter(tool => tool.execution !== "crank_native"));

// programs.worker.ts
import { createDurableToolRegistry } from "@sweatpants/durable-execution";
import { runDurableProgramWorker } from "@sweatpants/tool-runtime-local/worker";
import { tools } from "./tools";
await runDurableProgramWorker(createDurableToolRegistry(
  tools.filter(tool => tool.execution === "crank_native"),
));
```

Missing worker entries, duplicate tool names, missing durable bindings, missing
handlers, and mismatched effect contracts fail during app construction. Resource
startup remains lazy and belongs to the application scope. Closing the app cancels
its workers. Existing lower-level endpoint APIs remain available for custom hosts.

## Model defaults and scoped overrides

`pi({ provider, model, models?, streamOptions? })` returns a provider-neutral
`ChatModel`: `{ model, driver, streamOptions? }`. It uses the same Pi collection
for resolution and execution; existing credential-store behavior is unchanged.
Custom providers can supply `ChatModel` directly.

The model is installed in the application scope, before `setup.application`.
Both chat and ordinary tool sampling inherit it. `setup.chat` runs in a child scope
and may install a request-specific provider/model. Duplicate driver installations
within one scope still fail. Only explicitly supplied sampling options override
model defaults. Advanced `installChatTools` callers can supply a sampling provider.

## Effect implementations

Declare effects with `defineEffect()` beside a durable tool. Bind their host
implementations using `implementEffect` from `@sweatpants/agent-sdk`:

```ts
const effects = [
  implementEffect(drawCards, function* (input, ctx) {
    return yield* drawFromDeck(input, ctx.pullId);
  }),
];
```

This retains the declaration's runtime validators and retry-safety contract and
wraps the result as a successful effect disposition. The implementation must honor
that retry contract. For cancellation, partial results, or explicit failure
outcomes, use `createDurableEffectRegistration` directly.

## Routing and custom execution adapters

```ts
import { local } from "@sweatpants/tool-runtime-local";
import { routeTools } from "@sweatpants/tool-session/execution";
import { agentCore } from "@sweatpants/tool-runtime-agentcore";

execution: routeTools({
  default: local({ worker, durableWorker }),
  routes: [{ name: "remote-tools", tools: [remoteTool], runtime: agentCore({ runtime: remoteRuntimeOptions }) }],
})
```

`inProcess({ setup })` retains the host crank's durable-program execution for
advanced scoped capabilities such as yo-studio workspace operations. It accepts
durable programs only; it does not run ordinary tools inline.

Routes reference definitions from the app's `tools` list. Give a route a stable
`name` when its membership can change across deployments; otherwise its identity
is derived from the sorted tool names, independently of route ordering. Overlaps, unknown tools,
and uncovered tools without a default are configuration errors. Each runtime owns
its invocation resources; the shared host handles turns, elicitation, and sampling.
Recovery opens persisted resources through the configured adapters, without a
host-local routing cache. A resource belonging to another route fails closed.

AgentCore's `runtime` accepts invocation-runtime options or an operation that
resolves them during application setup. Remote durable tools additionally require
`durable: { journalId, release, driver, availablePrograms, availableEffects,
availableSchemaDigests }`. Readiness checks use exact program identities and
schema/effect keys; remote bindings preserve fenced activation. An optional `route`
function supplies development-collection placement fields. AWS-specific code lives
in the separate `server/agentcore` entry point.

Custom adapters implement `ToolExecutionAdapter.prepare(tools, routeId)`, returning
an optional resource-factory operation, durable bindings/drivers, and per-program
scoped setup. `driverFactories` acquire resource-owning drivers in the application
scope, so workers can outlive an individual activation. `runtimeId` identifies ordinary execution references and must remain
stable across deployments. The built-in local and AgentCore adapters preserve
`local` and `agentcore`; mixed routing uses `tools`. This placement boundary does
not replace journal or execution semantics.
`installChatTools({ tools, execution, effects })` provides the same composition
inside a caller-owned Effection scope. Omit `tools` on `createChatApp` only when
`setup.application` supplies the complete lower-level runtime itself.

## What `name` + `secret` derive

| Derived piece | Value |
|---|---|
| Journal capability audience & prefix | `${name}-program-driver` |
| Journal capability key id | `${name}-program-driver-v1` |
| Projection-token HMAC keys | derived from `secret` |
| History-read authorization | `authorized` (override for exposed deployments) |

`name` is durable identity: changing it orphans existing journals, so treat it
like a database name. `secret` must contain 32–4096 UTF-8 bytes; rotating it
invalidates outstanding history-page cursors but not stored conversations.

## Storage

Storage is one explicit choice; there is no implicit fallback.

```ts
storage: { kind: "sqlite", path: "/var/lib/my-app/authority.sqlite" }
storage: { kind: "postgres", connectionString }
storage: { kind: "memory" }                       // non-durable, tests/tooling
storage: { kind: "custom", conversationStore, executionStore } // bring your own
```

`chatStorageFromEnv({ defaultPath })` resolves the standard environment
contract, shared by every sweatpants app:

| Environment | Result |
|---|---|
| _(unset)_ | SQLite at `SWEATPANTS_DB_PATH` or `defaultPath` |
| `SWEATPANTS_STORAGE=memory` | explicit in-memory storage |
| `SWEATPANTS_STORAGE=postgres` | PostgreSQL using `SWEATPANTS_PG_URL` |
| `SWEATPANTS_STORAGE=<anything else>` | configuration error |
| `SWEATPANTS_STORAGE=memory` + `SWEATPANTS_DB_PATH` | configuration error |
| `SWEATPANTS_DB_PATH=""` | configuration error |

Path mode opens lazily on the first request: the application creates parent
directories, runs migrations, and enables WAL on one app-owned handle, then
closes it in `app.close()`. In database mode the binding opens when the author
creates it (typically at composition — an unopenable path fails loudly at
startup, which is the fail-closed behavior you want) and kernel migrations run
at the first request. Open, migration, or schema-compatibility failures
fail the request closed — storage never silently degrades to memory and files
are never deleted automatically.

### Binding inversion: own the connection yourself

Applications that want their own tables beside the authority tables — a
thread list, user preferences, anything durable — own the binding and hand it
to the kernel. The binding is the `better-sqlite3` connection, not the ORM;
each consumer builds its own drizzle view over it:

```ts
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import {
  chatStorageFromEnv,
  createChatApp,
  openChatStorageDatabase,
} from "@sweatpants/agent-host/server";
import { local } from "@sweatpants/tool-runtime-local";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteSchema } from "@sweatpants/storage-sqlite/schema";
import { myTables } from "./db/schema";

const selection = chatStorageFromEnv({
  defaultPath: new URL("../.data/my-app.sqlite", import.meta.url),
});
const database = openChatStorageDatabase(selection); // caller-owned when sqlite
const app = createChatApp({
  name: "my-app",
  secret,
  storage: database ? { kind: "sqlite", database } : selection,
  tools: [myDurableTool],
  execution: local({ durableWorker }),
});

// One connection, two ORM views:
const orm = drizzle(database!, { schema: { ...sqliteSchema, ...myTables } });
```

The rules that make this safe:

- **The owner closes.** The kernel never closes a caller-owned binding;
  `app.close()` leaves it open. Path mode closes what it created.
- **The `sp_` prefix is reserved.** Any SQLite object (table, view, index,
  trigger) named `sp_*` that the kernel does not manage fails the open closed.
  Non-prefixed co-tenant objects are invisible to kernel validation.
- **Write discipline.** The kernel binding is kernel-exclusive for writes
  (its transactions hold `BEGIN IMMEDIATE` across awaits). Write your co-tenant
  tables through your own connection to the same file; reads may use any
  connection. Kernel connections set `busy_timeout ≥ 5000 ms`, so
  cross-connection contention waits instead of failing.
- **One writer process.** Unchanged: one process owns the file. Multiple
  connections inside that process are expected.

### Reading authority data: two tiers

| Tier | Import | Stability | Use for |
|---|---|---|---|
| 1 — schema | `@sweatpants/storage-sqlite/schema` | additive-only in minors; breaking = major | full SQL expressiveness, admin tooling |
| 2 — client | `@sweatpants/storage-sqlite/client` | stable read models | thread lists, transcript pages, product UIs |

```ts
import { createChatStorageClient, openChatStorageReader } from "@sweatpants/storage-sqlite/client";

// Tier 2 over any disciplined binding:
const client = createChatStorageClient(orm);
client.threads.list();                       // non-deleted, newest first
client.threads.get(conversationId);
client.transcript.page(conversationId, { after: 10, limit: 50 });

// Out-of-process tools (inspectors, ops) get a read-only binding:
const reader = openChatStorageReader("/var/lib/my-app/authority.sqlite");
const roClient = createChatStorageClient(reader.database);
reader.close();
```

The client façade is read-only by construction: authority mutations belong to
kernel operations only. Neither tier adds authorization — filesystem access to
the SQLite file is the trust boundary. Kernel tables come into existence when
the kernel first opens with `migrate: true` (path mode) or on the first
request (database mode); read from them only after that, or open the file once
with `openBetterSqliteStorage(path, { migrate: true })` at startup to migrate
early.

### First consumer: yo-chat's thread list

yo-chat stores its sidebar thread metadata in a `thread_metadata` co-tenant
table on the same binding it hands to the kernel
(`apps/yo-chat/src/lib/thread-metadata-store.ts`). The list survives restarts
because it is read from SQLite, not memory.

## Lifecycle seams

| Option | Scope | Use for |
|---|---|---|
| `setup.application(ctx)` | once per application, before its first operation | durable streams, tool inventories, logging |
| `setup.chat(ctx)` | chat execution, including reconnect; not history paging | model provider installation, chat contexts |
| `shutdownDeadlineMs` | close | max graceful drain (default 30 s) |

```ts
createChatApp({
  // …
  setup: {
    application: function* ({ signal }) {
      yield* setupInMemoryDurableStreams();
      yield* installToolInventory(inventory);
    },
    chat: function* ({ request, body }) {
      yield* installMyModelProvider({ request, body });
    },
  },
});
```

## Inspection

`app.inspect()` resolves the live authority composition — conversation store,
execution store, and workflow journal store — opening storage if no request
has arrived yet. Use it for development inspectors and diagnostics, never for
request handling:

```ts
const { programDriverJournalStore } = await app.inspect();
```

## Advanced overrides

Every derived piece accepts an explicit override, individually or wholesale:

```ts
createChatApp({
  name: "my-app",
  secret: process.env.MY_APP_SECRET!,
  storage,
  // Real deployments exposing history routes MUST authenticate them:
  authorizeHistoryRead: function* (request, conversationId) {
    return (yield* authenticate(request, conversationId)) ? "authorized" : "forbidden";
  },
  // Custom journal composition (owns schema registration):
  createProgramDriverJournalStore: (executionStore) =>
    createProgramDriverJournalStore({ keyring, schemaRegistry, executionStore }),
  projectionTokens: createProjectionTokenKeyring(rotatingSecret, [previousSecret]),
});
```

Without `secret`, the explicit pieces become required: the type system accepts
either `{ name, secret }` or
`{ createProgramDriverJournalStore, projectionTokens }`, never neither.

For endpoint-only composition (embedding into an existing scope-owning
application), `createChatEndpoints(config)` accepts `DurableChatHandlerConfig`, whose `setup`
is the chat execution hook. It exposes unbound scoped endpoints for hosts that
own their own lifecycle. `createChatApplication({ handler, setup })` remains
the low-level lifecycle primitive; its `setup` configures the application scope.
Neither is needed for ordinary HTTP mounting with `createChatApp`.

## Reference examples

- `apps/yo-chat/src/server/chat-handler.ts` — production app, env-driven storage, durable tools
- `apps/yo-studio/src/server/durable-chat-application.ts` — workspace tooling with `setup.application`
- `apps/yo-agent/src/lib/in-process-handler.ts` — endpoint-only embedding

## Execution package boundaries

`agent-host` consumes the placement contract from `@sweatpants/tool-session/execution`.
It has no production dependency on either concrete execution adapter. Import
`local()` from `@sweatpants/tool-runtime-local` and `agentCore()` from
`@sweatpants/tool-runtime-agentcore`. `routeTools()` and the advanced
`ToolExecutionAdapter` contract belong to `@sweatpants/tool-session/execution`.

The neutral entry owns invocation orchestration and durable ephemeral-effect
bridging over `ToolInvocationHostPort`. Runtime packages own worker or remote
resources. The host validates authored tools and installs the prepared bindings;
the journal remains the execution authority. `inProcess()` remains a host helper
because it explicitly places durable programs in the host crank.
