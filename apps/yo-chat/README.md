# yo-chat

Reference product app and **production-candidate cutover** target for Sweatpants
(Phases 0–5 product surface program).

- Product surface / lanes: [`docs/product-surface.md`](../../docs/product-surface.md)
- Ops: [`docs/ops.md`](./docs/ops.md)
- Cutover report: [`docs/cutover-yo-chat.md`](../../docs/cutover-yo-chat.md)
- Durability Lab: `/lab/durability` (reconnect, elicit pause/resume, MCP HITL demos)

New features MUST target **product** and **canonical** lanes only — no new
experimental-lane imports.

# Getting Started

To run this application:

```bash
pnpm install
pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login --provider openai-codex
pnpm --filter yo-chat dev
```

## Development configurations

Use the launchers so workspace dependencies are rebuilt from current sources
before Vite or the server imports them:

| Command (repository root)              | Configuration                                                |
| -------------------------------------- | ------------------------------------------------------------ |
| `pnpm --filter yo-chat dev`            | Node host, selected real model, configured storage and tools |
| `pnpm --filter yo-chat dev:local`      | Node host, local tool workers                                |
| `pnpm --filter yo-chat dev:cloudflare` | Conversation DO host, D1, DO tool executors                  |
| `pnpm --filter yo-chat dev:d1`         | Node host with local Cloudflare storage                      |
| `pnpm --filter yo-chat dev:agentcore`  | Node host with configured AgentCore runtime                  |
| `pnpm --filter yo-mcp dev`             | MCP server                                                   |
| `pnpm --filter yo-agent dev`           | Terminal agent                                               |
| `pnpm --filter yo-studio dev`          | Studio                                                       |

Root `pnpm dev` starts yo-chat. App-local `pnpm dev` commands use the same preparation. Arguments pass through,
for example `pnpm --filter yo-chat dev:cloudflare --port 8008`. Both `--mode cloudflare`
and `--mode=cloudflare` initialize Cloudflare storage and credentials. The
launcher stops if a dependency build, credential refresh, or storage preparation
fails. It does not launch against an older successful build.

Vite refreshes its dependency optimization cache on launch, keeps caches separate
by mode, and fails if the requested port is occupied. Stop the old app before
relaunching it after package changes; a running Node process may retain imported
modules. Launch preparation does not provision remote infrastructure. The
`d1-local` configuration still needs the metadata Worker described below;
AgentCore requires a configured runtime (or the existing `:agentcore:auto` /
`:remote` provisioning launchers).

Playwright server startup uses the same dependency preparation. Its deterministic
presentation tests do not require credential refresh; live tests retain their
real-provider setup. Simulator scenarios belong in Test Rig, never in a running
app. `yo-slides` is independent of the framework package graph and retains its
Slidev commands.

## Cloudflare execution preparation

The optional Dynamic Worker placement runs the existing durable pick-card and play-ttt
programs in request-scoped Dynamic Workers, using returned RPC targets for live
generator attachments. Its entry is `src/server/cloudflare-tool-executor.ts`.
`wrangler.tools.jsonc` bundles that entry for the Worker Loader. Check the bundle
without deploying:

```bash
pnpm -C apps/yo-chat exec wrangler deploy --config wrangler.tools.jsonc --dry-run
```

The pick-card acceptance test exercises the adapter under real workerd, destroys
the executor process while parked, reconnects, and completes the same turn:

```bash
pnpm -C apps/yo-chat exec vitest run acceptance/pick-card-terminal-publication.acceptance.test.ts
```

That executor-only test keeps ingress on Node. The main `cloudflare` mode uses
`ToolExecutors = createToolExecutorObject({ tools })` and
`cloudflare({ executors: env.TOOL_EXECUTORS, sessions: env.TOOL_SESSIONS })`,
without a Worker Loader or dynamically bundled tool code. It
runs yo-chat SSR and HTTP ingress in a Worker, with the chat host in a named
Durable Object per conversation by default. It combines:

- D1 conversation/execution journals and separate thread metadata.
- Durable Objects for response buffers, writer fences, and registry entries.
- Disposable Durable Object executors for durable tools (`pick_card`, `play_ttt`).
- Durable Objects for ordinary tool sessions (`book_flight`, `tictactoe`, etc.).

```sh
# Conversation DO (default)
pnpm --filter yo-chat dev --mode cloudflare
# Run conversation orchestration in the ingress Worker instead
CHAT_HOST_PLACEMENT=worker pnpm --filter yo-chat dev --mode cloudflare
pnpm -C apps/yo-chat exec vite build --mode cloudflare
pnpm -C apps/yo-chat exec vitest run acceptance/cloudflare-host.acceptance.test.ts
```

The launcher refreshes the selected local Pi credential, passes it to the Worker
as a secret binding, and initializes local D1 before starting Vite. Local Worker
state lives under `.wrangler/worker-state`, separate from the Node + D1 mode below.
Model credentials are request-local snapshots: this local development path does
not persist OAuth rotations performed inside the Worker. Restart through the
launcher to refresh credentials. A deployed credential owner remains future work.
Pi's bundled OAuth entry is required because filesystem dynamic imports cannot
resolve inside a bundled Worker.

`CHAT_HOST_PLACEMENT` accepts `worker` or `durable-object`; configure the
Wrangler variable for deployments or override it in the launcher environment
locally. Invalid values fail explicitly. This chooses conversation orchestration
only: tool placement remains the independent `cloudflare({ executors, sessions })`
or `cloudflare({ worker, sessions })` adapter. Dynamic Worker tool execution is
still available through that adapter; the demo defaults to DO executors.

The ingress forwards commands, reconnects, and history requests to the same
conversation DO and passes the response stream through unchanged. This demo is
single-tenant; an authenticated deployment must include its trusted tenant
identity in the DO routing key. DO placement does not provide background wakeups
or unlimited CPU. D1 remains the journal authority, and concurrent requests still
use its existing fencing rather than relying on DO request serialization.

Each HTTP request creates its own application and RPC targets. The runtime's
`createChatFetchHandler(() => createApp())` keeps that application alive until
response EOF, cancellation, or failure, without reading ahead. A later request
replays durable tools from D1; ordinary tools reconnect to their live DO session.
No Node executor fallback is used. Native SQLite/Postgres setup loads only when that backend is selected;
`openChatStorageDatabase` is available from `@sweatpants/agent-host/node`. The combined acceptance suite replaces the
entire workerd process while a card is parked and verifies replay and history,
then exercises the flight and tic-tac-toe flows through both Worker and conversation DO hosts.

This is local Worker validation, not a deployed Cloudflare certification. Live
Codex access from local workerd currently receives an upstream rejection; the
combined acceptance suite uses the real Pi HTTP adapter with Test Rig's model
simulator. Simulation is confined to tests; running the app and validating it in
the browser require a real provider. Cloud D1 provisioning and durable activation scheduling (wakeups/alarms)
are outside this cut. Existing ordinary-tool session expiration is unchanged.

## Local Cloudflare storage

The `d1-local` mode stores conversation and execution journals in D1 through
`@sweatpants/storage-d1`. Thread sidebar metadata uses its own D1 Worker. That Worker also exports
`ResponseStream`, a SQLite-backed Durable Object for each response stream.
Response buffers, writer fences and session entries use the DO namespace, without
Redis or an in-memory fallback. The application host and model provider still run in Node; this mode is not a full
Cloudflare deployment. KV is not used.

```sh
# Apply the app-owned schema to local D1 (no cloud account required).
pnpm -C apps/yo-chat metadata:init:local
# Terminal 1: run the metadata Worker and response DOs on localhost:8788.
pnpm -C apps/yo-chat dev:metadata
# Terminal 2: run chat with a local workerd D1 journal binding.
pnpm --filter yo-chat dev --mode d1-local
```

The metadata Worker uses the same HTTP handler and normalization as the Node app.
D1 operations start at the primary for current reads, and partial updates use a
single SQL statement so concurrent changes to different fields do not overwrite
one another. Local D1 persists under `apps/yo-chat/.wrangler/state`; restarting the
metadata Worker preserves thread names, previews, counts and namespaces. The
transcript and execution journal also persist there in a separate D1 database.
`wrangler.journal.jsonc` selects that binding; the storage package provisions its
initial schema.
`wrangler.metadata.jsonc` and `schema/thread-metadata.sql` own this Worker and schema.

The library fits the existing storage port:

```ts
import { createD1Storage, initializeD1Storage } from "@sweatpants/storage-d1";

await initializeD1Storage(env.JOURNAL);
const app = createChatApp({
  name: "my-app",
  secret,
  storage: createD1Storage(env.JOURNAL),
  programs: [myTool],
});
```

D1 batches commit the receipt, journal records and authority change together.
The commit guard validates the authority revision and immutable aliases read by
that mutation. Unrelated conversations do not cause each other to retry; writers
racing shared identities retry with a fresh snapshot. Records are chunked to stay
below D1's row-size limit. D1's query, request and database limits still apply;
this local validation does not establish production capacity. See
[the D1 cost contract](../../packages/storage-d1/README.md) for measured read/write
budgets and remaining deployment limits. The sidebar uses bounded cursor pages
and restores older selections with a point lookup.

Response delivery uses the existing setup interface:

```ts
import { createCloudflareResponseStores } from "@sweatpants/durable-streams-cloudflare";

// Worker entrypoint:
export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";

// Application setup:
yield *
  setupDurableStreams({
    ...createCloudflareResponseStores<string>(env.RESPONSE_STREAMS),
    retentionPolicy: { mode: "retain_forever" },
  });
```

Readers pull bounded batches through the existing Effection stream. At the tail,
a reader waits for a DO notification; cancellation releases its waiter. A bounded
wait also releases abandoned requests after host loss. Stream offsets, terminal
state, writer fences and registry entries survive DO replacement. Tokens must be
JSON serializable and fit Cloudflare's storage/RPC limits.

These DOs store delivery state, separate from tool-execution DOs. They do not run
the chat generator or replace the D1 journal. The existing registry's reference
counts are bookkeeping, not leases: a crashed host can leave a stale count. This
local composition retains streams indefinitely; automatic expiry and lease-based
cleanup are not provided by this cut.

## Durable storage

Yo-chat uses SQLite for conversation and execution authority by default. The
first chat/history request lazily opens and initializes
`apps/yo-chat/.data/yo-chat.sqlite`; the application scope closes that handle
on shutdown. Set `SWEATPANTS_DB_PATH` to use another local file.

```bash
SWEATPANTS_DB_PATH=/var/lib/yo-chat/authority.sqlite pnpm --filter yo-chat dev
```

Yo-chat owns that binding and hands it to the kernel (binding inversion): its
sidebar thread metadata lives in a `thread_metadata` co-tenant table in the
same file, so the thread list survives restarts. The `sp_` prefix is reserved
for kernel tables; yo-chat's own tables use unprefixed names and are written
through yo-chat's own connection. See
[`docs/chat-application-configuration.md`](../../docs/chat-application-configuration.md)
for the full rules.

SQLite WAL mode requires a local filesystem and one owning application process.
Do not place the file on a network filesystem or share one writable file across
processes. For an incompatible pre-release schema, stop the app and explicitly
remove or replace the file; the app never deletes it automatically.

Tests and tooling may opt into non-durable storage with
`SWEATPANTS_STORAGE=memory`. Combining that override with
`SWEATPANTS_DB_PATH` is a configuration error.

`REDIS_URL` configures volatile response tails and AgentCore session caches
only. Redis is not conversation or execution authority.

## Model providers and auth

yo-chat persists credentials and the selected model once in the repository-local,
git-ignored `.sweatpants/auth.json` (override with `YO_CHAT_MODEL_AUTH_FILE`). No
secret is copied into `.env.local`. Environment variables remain useful for CI
or one-off overrides.

```bash
# GitHub Copilot device OAuth
pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login --provider github-copilot

# ChatGPT browser OAuth or choose the headless device-code flow when prompted
pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login --provider openai-codex --model gpt-5.5

# OpenCode Zen API key (prompted once)
pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login --provider opencode --model gpt-5.5

# Change the selected provider/model without reauthenticating
pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:use --provider github-copilot --model claude-sonnet-4.6

# Redacted status and OAuth refresh
pnpm --filter @sweatpants/model-provider-pi-ai dev:auth
pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:refresh
```

`pnpm --filter yo-chat dev` uses the selected model automatically. An explicit
`DEFAULT_CHAT_MODEL_PROVIDER` / `DEFAULT_CHAT_MODEL_ID` pair overrides it for
that process.

Server setup uses one configured adapter for model lookup and execution:

```ts
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";

const pi = createPiAiModelProvider();
const model = pi.resolveModel({ provider: "openai-codex", id: "gpt-5.5" });

// In createChatApp({ setup: { chat } }):
function* chat() {
  yield* pi.install({ model, streamOptions: { maxTokens: 4096 } });
}
```

Pass `createPiAiModelProvider({ models })` to use a Pi `Models` collection with
custom providers or credentials. That same collection handles resolution and
requests, including later catalog updates. Unknown models fail resolution.
Request allow-list policy remains in `resolveModelSelection`, before lookup.
`pi.driver` exposes the canonical Sweatpants provider port implementation;
`pi.runtime` also exposes image generation. Installation is Effection-scoped.

## MCP tool runtime mode

yo-chat can run MCP plugin tool sessions in either local mode or AgentCore mode.
The chat handler, UI, elicitation handling, sampling provider, and durable app state remain local in both modes.

### Local mode

This is the default. Tool generators run in the local Sweatpants worker/session runtime.

```bash
MCP_TOOL_RUNTIME=local pnpm dev
```

### AgentCore mode

In this mode, the local app stores AgentCore `ToolSession` handles and invokes AWS Bedrock AgentCore Runtime for tool execution. The AgentCore runtime image packages the generated AgentCore tool registry from `src/tools`.

> **Paid invocation warning:** `MCP_TOOL_RUNTIME=agentcore` with a real `AGENTCORE_RUNTIME_ARN` can invoke paid AWS Bedrock AgentCore Runtime services. Selecting AgentCore as the configured runtime is the approval boundary; there is no separate app-mode approval environment variable.

```bash
DEFAULT_CHAT_MODEL_PROVIDER=amazon-bedrock \
DEFAULT_CHAT_MODEL_ID=zai.glm-5 \
AWS_REGION=<region> \
MCP_TOOL_RUNTIME=agentcore \
AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:<region>:<account-id>:runtime/<runtime-id> \
AGENTCORE_REGION=<region> \
AGENTCORE_ENDPOINT_NAME=DEFAULT \
pnpm dev
```

Configure the default chat model with `DEFAULT_CHAT_MODEL_PROVIDER` and `DEFAULT_CHAT_MODEL_ID` (for example `openai`/`gpt-5-chat-latest`, or `amazon-bedrock`/`zai.glm-5`). AgentCore mode only moves MCP tool execution remote; primary chat inference still runs in the local app server through pi-ai. Unknown model IDs are rejected; selection must resolve through the installed Pi model catalog.

Runtime selection is binary: `local` runs the complete generated tool registry in local workers, while `agentcore` runs that same complete registry in AgentCore. There is no per-tool hybrid router.

Runtime settings:

```bash
AGENTCORE_TOOL_SESSION_TTL_MS=900000
AGENTCORE_REDIS_KEY_PREFIX=sp:yo-chat:agentcore:
REDIS_URL=redis://localhost:6379

# The authority-backed workflow host is the only HTTP chat engine. Its
# capability secret is required and must contain at least 32 bytes. Conversation
# and execution authority use the SQLite file described above.
PROGRAM_DRIVER_CAPABILITY_SECRET='replace-with-at-least-32-random-bytes'

# Optional chat model allow-list. When unset, only the configured default is allowed.
ALLOWED_CHAT_MODELS_JSON='[{"provider":"amazon-bedrock","id":"zai.glm-5"},{"provider":"github-copilot","id":"claude-sonnet-4.6"}]'

# Developer-only opt-out from allow-list checks. Resolution still must succeed.
UNSAFE_ALLOW_ANY_CHAT_MODEL=yes

# AgentCore-hosted tools default to host-mediated ctx.sample(). Enable internal
# AgentCore sampling only when the runtime has credentials/network access for the sample model.
# If internal sampling is used while the chat model is app-local (for example
# github-copilot), configure this explicit AgentCore-reachable sample model.
AGENTCORE_TOOL_SAMPLE_MODE=host # host | internal
AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER=amazon-bedrock
AGENTCORE_TOOL_SAMPLE_MODEL_ID=zai.glm-5
```

The selected runtime receives the complete generated tool inventory. If `REDIS_URL` is set, AgentCore session handles/events are stored in Redis. Otherwise they use in-memory app-side stores for local development.

The workflow host uses concrete ToolSession registries to journal tool sampling and elicitation. Both local and AgentCore modes expose those operations through the same journal-aware foreign adapter child.

# Building For Production

To build this application for production:

```bash
pnpm build
```

## Testing

This project uses [Vitest](https://vitest.dev/) for testing. You can run the tests with:

```bash
pnpm test
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

## Routing

This project uses [TanStack Router](https://tanstack.com/router). The initial setup is a file based router. Which means that the routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add another a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you use the `<Outlet />` component.

Here is an example layout that includes a header:

```tsx
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { Link } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <>
      <header>
        <nav>
          <Link to="/">Home</Link>
          <Link to="/about">About</Link>
        </nav>
      </header>
      <Outlet />
      <TanStackRouterDevtools />
    </>
  ),
});
```

The `<TanStackRouterDevtools />` component is not required so you can remove it if you don't want it in your layout.

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/people",
  loader: async () => {
    const response = await fetch("https://swapi.dev/api/people");
    return response.json() as Promise<{
      results: {
        name: string;
      }[];
    }>;
  },
  component: () => {
    const data = peopleRoute.useLoaderData();
    return (
      <ul>
        {data.results.map((person) => (
          <li key={person.name}>{person.name}</li>
        ))}
      </ul>
    );
  },
});
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

### React-Query

React-Query is an excellent addition or alternative to route loading and integrating it into you application is a breeze.

First add your dependencies:

```bash
pnpm add @tanstack/react-query @tanstack/react-query-devtools
```

Next we'll need to create a query client and provider. We recommend putting those in `main.tsx`.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ...

const queryClient = new QueryClient();

// ...

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);

  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
```

You can also add TanStack Query Devtools to the root route (optional).

```tsx
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <ReactQueryDevtools buttonPosition="top-right" />
      <TanStackRouterDevtools />
    </>
  ),
});
```

Now you can use `useQuery` to fetch your data.

```tsx
import { useQuery } from "@tanstack/react-query";

import "./App.css";

function App() {
  const { data } = useQuery({
    queryKey: ["people"],
    queryFn: () =>
      fetch("https://swapi.dev/api/people")
        .then((res) => res.json())
        .then((data) => data.results as { name: string }[]),
    initialData: [],
  });

  return (
    <div>
      <ul>
        {data.map((person) => (
          <li key={person.name}>{person.name}</li>
        ))}
      </ul>
    </div>
  );
}

export default App;
```

You can find out everything you need to know on how to use React-Query in the [React-Query documentation](https://tanstack.com/query/latest/docs/framework/react/overview).

## State Management

Another common requirement for React applications is state management. There are many options for state management in React. TanStack Store provides a great starting point for your project.

First you need to add TanStack Store as a dependency:

```bash
pnpm add @tanstack/store
```

Now let's create a simple counter in the `src/App.tsx` file as a demonstration.

```tsx
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import "./App.css";

const countStore = new Store(0);

function App() {
  const count = useStore(countStore);
  return (
    <div>
      <button onClick={() => countStore.setState((n) => n + 1)}>Increment - {count}</button>
    </div>
  );
}

export default App;
```

One of the many nice features of TanStack Store is the ability to derive state from other state. That derived state will update when the base state updates.

Let's check this out by doubling the count using derived state.

```tsx
import { useStore } from "@tanstack/react-store";
import { Store, Derived } from "@tanstack/store";
import "./App.css";

const countStore = new Store(0);

const doubledStore = new Derived({
  fn: () => countStore.state * 2,
  deps: [countStore],
});
doubledStore.mount();

function App() {
  const count = useStore(countStore);
  const doubledCount = useStore(doubledStore);

  return (
    <div>
      <button onClick={() => countStore.setState((n) => n + 1)}>Increment - {count}</button>
      <div>Doubled - {doubledCount}</div>
    </div>
  );
}

export default App;
```

We use the `Derived` class to create a new store that is derived from another store. The `Derived` class has a `mount` method that will start the derived store updating.

Once we've created the derived store we can use it in the `App` component just like we would any other store using the `useStore` hook.

You can find out everything you need to know on how to use TanStack Store in the [TanStack Store documentation](https://tanstack.com/store/latest).

# Demo files

Files prefixed with `demo` can be safely deleted. They are there to provide a starting point for you to play around with the features you've installed.

# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

Local Cloudflare tool validation also exports `ToolSessions` from
`src/server/cloudflare-tool-sessions.ts`. The fixture installs this SQLite-backed
DO namespace beside the Dynamic Worker loader. Route ordinary tools with
`cloudflare({ sessions })`; use `cloudflare({ worker, sessions })` for a mixed
inventory. Ordinary DO sessions retain a generator across requests, with a bounded
ten-minute lifetime and explicit failure after compute loss. They do not replay
ordinary effects after restart.

### Shared local and retained tool execution

Tools keep fluent authoring through `createTool` or `createDurableTool`. The five
chat plugins import the corresponding `tools/primitive/` tool directly and pass
it to `makePlugin(tool)`. Vite extracts the browser contract from that definition;
authors do not declare or project a separate plugin contract.

All six retained tools delegate to those portable bodies through `invokeWith`.
Their modules provide native capabilities rather than copies of the tool logic.
`src/tools/schemas/` supplies the shared schemas and inferred Flight/SeatMap types.
Flight's mock backend is shared too; each placement keeps its delay ordering.

Portable authoring imports the SDK root. Retained card/game transport adapters
explicitly import the crank builder from `@sweatpants/agent-sdk/legacy`; their
implementation digests changed for this cutover. Catalogs, retry policies and the
longer retained `play_ttt` description remain placement-specific. Ordinary
tic-tac-toe now forwards the shared body's diagnostic progress notifications.
MCP's different `pick_card` remains a separate tool.
