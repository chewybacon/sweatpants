# Differentiator Demos

Product demos for the Sweatpants durability / human-in-the-loop wedge.

**Host:** yo-chat Durability Lab — `/lab/durability`  
**Docs path:** this directory (`docs/demos/`)

| Demo | User path | Automated gate |
|---|---|---|
| Reconnect mid-stream | `/chat/basic` | `packages/durable-chat-runtime/acceptance/demo-reconnect-mid-stream.acceptance.test.ts` |
| Elicit pause/resume | `/chat/flight` | `packages/platform-acceptance/src/product/golden-path.acceptance.test.ts` |
| MCP → browser elicit → result | `/chat/cards` | `apps/yo-chat/acceptance/demo-mcp-browser-elicit.acceptance.test.ts` |

All app import samples use the product facade only (see [product-surface.md](../product-surface.md)).

## Run the lab

```bash
# From monorepo root — local/in-memory defaults (no Redis / AgentCore required)
pnpm --filter yo-chat dev:local
# open http://localhost:8000/lab/durability
```

## Run automated demo gates

```bash
pnpm -C packages/durable-chat-runtime exec vitest run acceptance/demo-reconnect-mid-stream.acceptance.test.ts
pnpm -C packages/platform-acceptance test
pnpm -C apps/yo-chat exec vitest run acceptance/demo-mcp-browser-elicit.acceptance.test.ts
```

Walkthroughs: [reconnect](./reconnect-mid-stream.md) · [elicit pause/resume](./elicit-pause-resume.md) · [MCP browser HITL](./mcp-browser-elicit.md)
