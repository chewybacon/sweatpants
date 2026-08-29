# Configuring chat applications

`createChatApp` from `@sweatpants/agent-host/server` is the entry point for
building a durable chat application. One call produces the application
lifecycle (lazy setup, request handling, graceful close) and the route
endpoints, with production-grade SQLite authority storage by default.

## Quick start

```ts
import { chatStorageFromEnv, createChatApp } from "@sweatpants/agent-host/server";
import { myDurableTool } from "./tools/my-durable-tool";
import { installMyModelProvider } from "./model-provider";

export const app = createChatApp({
  name: "my-app",
  secret: process.env.MY_APP_SECRET!, // 32+ characters
  storage: chatStorageFromEnv({
    defaultPath: new URL("../.data/my-app.sqlite", import.meta.url),
  }),
  programs: [myDurableTool],
  setup: installMyModelProvider,
});
```

Mount it under any HTTP framework:

```ts
// POST /api/chat
app.handle(request);

// GET /api/chat/:conversationId (reconnect) and POST …/history:page
app.handleEndpoint(app.endpoints.readChat, { request, conversationId });
app.handleEndpoint(app.endpoints.pageHistory, { request, conversationId });

// Graceful shutdown: drains work and closes the SQLite handle.
await app.close();
```

That is the entire required surface. `name` and `secret` derive every signing
key; `programs` registers your durable tools' journal schemas; `storage`
selects the one authority store.

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
storage: { kind: "memory" }                       // non-durable, tests/tooling
storage: { kind: "custom", conversationStore, executionStore } // bring your own
```

`chatStorageFromEnv({ defaultPath })` resolves the standard environment
contract, shared by every sweatpants app:

| Environment | Result |
|---|---|
| _(unset)_ | SQLite at `SWEATPANTS_DB_PATH` or `defaultPath` |
| `SWEATPANTS_STORAGE=memory` | explicit in-memory storage |
| `SWEATPANTS_STORAGE=<anything else>` | configuration error |
| `SWEATPANTS_STORAGE=memory` + `SWEATPANTS_DB_PATH` | configuration error |
| `SWEATPANTS_DB_PATH=""` | configuration error |

SQLite opens lazily on the first request: the application creates parent
directories, runs migrations, and enables WAL on one app-owned handle, then
closes it in `app.close()`. Open, migration, or schema-compatibility failures
fail the request closed — storage never silently degrades to memory and files
are never deleted automatically.

## Lifecycle seams

| Option | Scope | Use for |
|---|---|---|
| `appSetup(ctx)` | once per application, before the first request | durable streams, tool inventories, logging |
| `setup(ctx)` | every request | model provider installation, request contexts |
| `shutdownDeadlineMs` | close | max graceful drain (default 30 s) |

```ts
createChatApp({
  // …
  setup: function* ({ request, body }) {
    yield* installMyModelProvider();
  },
  appSetup: function* ({ signal }) {
    yield* setupInMemoryDurableStreams();
    yield* installToolInventory(inventory);
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
  // Custom journal composition (replaces `programs`):
  createProgramDriverJournalStore: (executionStore) =>
    createProgramDriverJournalStore({ keyring, schemaRegistry, executionStore }),
  projectionTokens: createProjectionTokenKeyring(rotatingSecret, [previousSecret]),
});
```

Without `secret`, the explicit pieces become required: the type system accepts
either `{ name, secret }` or
`{ createProgramDriverJournalStore, projectionTokens }`, never neither.

For endpoint-only composition (embedding into an existing scope-owning
application), `createChatEndpoints(config)` accepts the same configuration
minus `appSetup`/`shutdownDeadlineMs`, and `createChatApplication({ handler })`
remains the low-level lifecycle primitive.

## Reference examples

- `apps/yo-chat/src/server/chat-handler.ts` — production app, env-driven storage, durable tools
- `apps/yo-studio/src/server/durable-chat-application.ts` — workspace tooling with `appSetup`
- `apps/yo-agent/src/lib/in-process-handler.ts` — endpoint-only embedding
