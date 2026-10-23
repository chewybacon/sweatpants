# Sweatpants

Production chat sessions that survive **reconnect**, **tool pause/resume**, and **human-in-the-loop** — correctly.

Sweatpants is a TypeScript agent/chat framework with a thin, versioned **product facade** over a durable session substrate. Start here; advanced substrate packages live under [Advanced / internal](#advanced--internal).

**Product surface (lanes + facade):** [`docs/product-surface.md`](./docs/product-surface.md)  
**Changelog:** [`docs/product-changelog.md`](./docs/product-changelog.md)  
**Demos:** [`docs/demos/`](./docs/demos/) · yo-chat Durability Lab `/lab/durability`

## Install targets (normal users)

At most four conceptual targets (concrete package names today):

| Conceptual           | Install / import today          | Job                                     |
| -------------------- | ------------------------------- | --------------------------------------- |
| `@sweatpants/react`  | `@sweatpants/react-chat`        | UI hooks / chat client                  |
| `@sweatpants/server` | `@sweatpants/agent-host/server` | Durable handler + app wiring            |
| `@sweatpants/tools`  | `@sweatpants/agent-sdk`         | `createTool` authoring                  |
| `@sweatpants/chat`   | `@sweatpants/chat-core`         | Protocol, frames, projection, authoring |

```bash
pnpm add @sweatpants/react-chat @sweatpants/agent-host @sweatpants/agent-sdk
```

## Quick start

### React chat client

```tsx
import { useChat } from "@sweatpants/react-chat";

function Chat() {
  const { messages, sendMessage, status } = useChat({
    threadId: "demo",
    api: "/api/chat",
  });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>{/* render message parts */}</div>
      ))}
      <input
        disabled={status === "submitted" || status === "streaming"}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void sendMessage({ text: e.currentTarget.value });
          }
        }}
      />
    </div>
  );
}
```

### Server wiring

```ts
import { createChatApp, chatStorageFromEnv } from "@sweatpants/agent-host/server";
import { myTool } from "./tools/my-tool";
import { installApplicationServices, installModelProvider } from "./server/setup";

export const app = createChatApp({
  name: "my-app",
  secret: process.env.MY_APP_SECRET!,
  storage: chatStorageFromEnv({
    defaultPath: new URL("./.data/chat.sqlite", import.meta.url),
  }),
  programs: [myTool],
  setup: {
    application: installApplicationServices,
    chat: installModelProvider,
  },
});

// Mount at /api/chat and /api/chat/* in your framework.
export const GET = app.handler;
export const POST = app.handler;
```

Application setup installs streams, tool inventories, and logging. Chat setup
installs the model provider and chat contexts. Use `app.api.*` for direct server
calls and `app.close()` at shutdown. See [configuration](./docs/chat-application-configuration.md).

### Tool authoring

```ts
import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

export const bookFlight = createTool("book_flight")
  .description("Book a flight for the user")
  .parameters(
    z.object({
      from: z.string(),
      to: z.string(),
      date: z.string(),
    }),
  )
  .elicits({
    confirm: {
      response: z.object({ confirmed: z.boolean() }),
    },
  })
  .execute(function* ({ from, to, date }, ctx) {
    const response = yield* ctx.elicit("confirm", {
      message: `Book flight from ${from} to ${to} on ${date}?`,
    });

    if (response.action === "accept" && response.content.confirmed) {
      return { status: "booked", confirmation: "ABC123" };
    }
    return { status: "cancelled" };
  });
```

### Plugin UI binding

```ts
import { makePlugin } from "@sweatpants/react-chat";
import { bookFlight } from "./book-flight";
import { ConfirmFlight } from "./ConfirmFlight";

export const bookFlightPlugin = makePlugin(bookFlight)
  .onElicit({
    confirm: function* (input, ctx) {
      const confirmed = yield* ctx.render(ConfirmFlight, {
        message: input.message,
      });
      return { action: "accept" as const, content: { confirmed } };
    },
  })
  .build();
```

## Differentiator demos

| Demo                 | Path                   | Docs                                                                       |
| -------------------- | ---------------------- | -------------------------------------------------------------------------- |
| Reconnect mid-stream | yo-chat `/chat/basic`  | [docs/demos/reconnect-mid-stream.md](./docs/demos/reconnect-mid-stream.md) |
| Elicit pause/resume  | yo-chat `/chat/flight` | [docs/demos/elicit-pause-resume.md](./docs/demos/elicit-pause-resume.md)   |
| MCP → browser HITL   | yo-chat `/chat/cards`  | [docs/demos/mcp-browser-elicit.md](./docs/demos/mcp-browser-elicit.md)     |

Lab index: `/lab/durability` in yo-chat.

## Reference app

| App            | Role                                         |
| -------------- | -------------------------------------------- |
| `apps/yo-chat` | Reference + production-candidate cutover app |

Ops: [`apps/yo-chat/docs/ops.md`](./apps/yo-chat/docs/ops.md)

## Development

The root exposes seven task namespaces: `lint`, `format`, `build`, `check`, `test`,
`dev`, and `land`. The first six run the same task in every workspace that provides
it. Use native pnpm filters to select a workspace; `land` exists only at the root
and explicitly controls the final verification workflow.

```bash
pnpm install
pnpm build                           # all workspace builds
pnpm build:check                     # export and product-surface validation
pnpm check                           # production + test types, including apps
pnpm --filter @sweatpants/acceptance test
pnpm --filter yo-chat dev:local
pnpm land                            # lint, format check, types, public acceptance
```

`pnpm format` writes formatting; `pnpm format:check` checks it. `pnpm test` runs
all workspace suites, including repository tooling, apps and public acceptance.
`pnpm dev` starts all workspace dev tasks in parallel; use a filter for a single
app. Subtasks keep the same namespace: `pnpm build:clean` fans out to workspace
`build:clean` tasks. See [docs/verification.md](./docs/verification.md).

## Advanced / internal

Canonical substrate packages (not the default shopping list):

| Package                                   | Role                                       |
| ----------------------------------------- | ------------------------------------------ |
| `@sweatpants/durable-execution`           | Session kernel under the durable handler   |
| `@sweatpants/durable-streams`             | Token buffers / reconnect protocol         |
| `@sweatpants/stream-bridge`               | Effection ↔ Web stream bridge              |
| `@sweatpants/tool-runtime-local`          | Local/worker tool runtime (app wiring)     |
| `@sweatpants/tool-runtime-agentcore`      | AgentCore remote tool runtime (app wiring) |
| `@sweatpants/model-provider-pi-ai`        | Model provider adapter (app wiring)        |
| `@sweatpants/tool-session/elicit-context` | Elicit context encode/decode               |
| `@sweatpants/vite-plugin`                 | App Vite plugin                            |
| `@sweatpants/cli`                         | MCP/codegen CLI tooling                    |

See [`docs/product-surface.md`](./docs/product-surface.md) for lane classification. Historical and superseded docs are deleted, not archived; recover them with `git log --follow --diff-filter=D -- docs/`.

## License

MIT
