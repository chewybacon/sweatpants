# Demo 3: MCP tool → browser elicit → MCP result

**Claim:** An external MCP client (or MCP-style plugin tool session) that invokes a tool which elicits in the browser chat UI stays in-flight until the human completes the elicit, then returns a coherent tool result (success or structured cancellation) without hanging past the harness timeout.

**Time:** under 3 minutes · **No Effection literacy required**

## User path

1. Start yo-chat: `pnpm dev:yo-chat:local`
2. Open [Card Picker](http://localhost:8000/chat/cards/)
3. Trigger the card-picking flow so the tool waits on a human choice
4. Select a card in the browser UI
5. Confirm the tool call completes with a normal result (no hang)

Optional: decline/cancel paths also return structured terminal results.

## Product imports (sample)

```ts
import { createTool } from "@sweatpants/agent-sdk";
import { makePlugin } from "@sweatpants/framework/chat";
import type { RenderableProps } from "@sweatpants/framework/chat/browser-rendering";

export const pickCard = createTool("pick_card")
  .description("Draw cards and let the user pick one")
  .parameters(/* zod */)
  .elicits({ pickCard: { response: /* schema */ } })
  .execute(function* (params, ctx) {
    const picked = yield* ctx.elicit("pickCard", { message: "Pick a card" });
    // return coherent result
  });

export const pickCardPlugin = makePlugin(pickCard).onElicit({
  pickCard: function* (req, ctx) {
    // browser UI via ctx.render(...)
  },
});
```

## Automated gate

```bash
pnpm -C apps/yo-chat exec vitest run acceptance/demo-mcp-browser-elicit.acceptance.test.ts
```

Classification: **acceptance** (protocol/bridge via local tool runtime). UI e2e for card picker remains complementary under `apps/yo-chat/e2e`.
