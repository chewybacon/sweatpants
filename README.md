# Sweatpants

Production chat sessions that survive **reconnect**, **tool pause/resume**, and **human-in-the-loop** — correctly.

Sweatpants is a TypeScript agent/chat framework with a thin, versioned **product facade** over a durable session substrate. Start here; advanced substrate packages live under [Advanced / internal](#advanced--internal).

**Product surface (lanes + facade):** [`docs/product-surface.md`](./docs/product-surface.md)  
**Changelog:** [`docs/product-changelog.md`](./docs/product-changelog.md)  
**Demos:** [`docs/demos/`](./docs/demos/) · yo-chat Durability Lab `/lab/durability`

## Install targets (normal users)

At most four conceptual targets (concrete package names today):

| Conceptual           | Install / import today         | Job                                     |
| -------------------- | ------------------------------ | --------------------------------------- |
| `@sweatpants/react`  | `@sweatpants/react-chat`       | UI hooks / chat client                  |
| `@sweatpants/server` | `@sweatpants/framework/server` | Durable handler + app wiring            |
| `@sweatpants/tools`  | `@sweatpants/agent-sdk`        | `createTool` authoring                  |
| `@sweatpants/chat`   | `@sweatpants/framework/chat`   | Plugins, session helpers, advanced chat |

```bash
pnpm add @sweatpants/react-chat @sweatpants/framework @sweatpants/agent-sdk
```

## Quick start

### React chat client

```tsx
import { useChat, ChatProvider } from "@sweatpants/react-chat";

function Chat() {
    const { messages, send, isStreaming } = useChat({
        baseUrl: "/api/chat",
    });

    return (
        <div>
            {messages.map((msg) => (
                <div key={msg.id}>{/* render message parts */}</div>
            ))}
            <input
                disabled={isStreaming}
                onKeyDown={(e) => {
                    if (e.key === "Enter") send(e.currentTarget.value);
                }}
            />
        </div>
    );
}
```

`useChatSession` is available from the same package when you need buffers/reconnect controls.

### Server wiring

```ts
import { createChatApplication, createChatHandler } from "@sweatpants/framework/server";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";

export function createApp() {
    return createChatApplication({
        setup: function* () {
            // Local/in-memory default — no Redis required for happy path
            yield* setupInMemoryDurableStreams<string>();
            // wire model provider + tools in your app setup
        },
        handler: createChatHandler({
            setup: function* (/* request ctx */) {
                // set model provider for this request
            },
            maxToolIterations: 10,
        }),
    });
}
```

`createDurableChatHandler` is an alias of `createChatHandler`.

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
import { makePlugin, getElicitContext } from "@sweatpants/framework/chat";
import { bookFlight } from "./book-flight";

export const bookFlightPlugin = makePlugin(bookFlight).onElicit({
    confirm: function* (req, ctx) {
        const context = getElicitContext(req);
        // render confirm UI via ctx.render(...); return accept/decline
        return { action: "accept" as const, content: { confirmed: true } };
    },
});
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

```bash
pnpm install
pnpm build
pnpm validate:product-surface   # facade allowlist + product import policy
pnpm validate:exports

# Golden-path + differentiator acceptance
pnpm -C packages/framework test:acceptance

# Reference app
pnpm dev:yo-chat:local
```

## Advanced / internal

Canonical substrate packages (not the default shopping list):

| Package                              | Role                                       |
| ------------------------------------ | ------------------------------------------ |
| `@sweatpants/session-contract`       | Session kernel under the durable handler   |
| `@sweatpants/durable-streams`        | Token buffers / reconnect protocol         |
| `@sweatpants/stream-bridge`          | Effection ↔ Web stream bridge              |
| `@sweatpants/tool-runtime-local`     | Local/worker tool runtime (app wiring)     |
| `@sweatpants/tool-runtime-agentcore` | AgentCore remote tool runtime (app wiring) |
| `@sweatpants/model-provider-pi-ai`   | Model provider adapter (app wiring)        |
| `@sweatpants/elicit-context`         | Elicit context encode/decode               |
| `@sweatpants/vite-plugin`            | App Vite plugin                            |
| `@sweatpants/cli`                    | MCP/codegen CLI tooling                    |

See [`docs/product-surface.md`](./docs/product-surface.md) for lane classification. Historical and superseded docs are deleted, not archived; recover them with `git log --follow --diff-filter=D -- docs/`.

## License

MIT
