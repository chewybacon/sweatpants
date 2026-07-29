# Demo 2: Elicit pause/resume

**Claim:** A tool that issues an elicit remains resumable across client disconnect. When the user returns and answers, the turn continues without re-issuing the same logical elicit as a new wait identity.

**Time:** under 3 minutes · **No Effection literacy required**

## User path

1. Start yo-chat: `pnpm dev:yo-chat:local`
2. Open [Flight Booking](http://localhost:8000/chat/flight/)
3. Ask to book a flight (e.g. “Book a flight from Boston to NYC”)
4. When the flight picker UI appears, refresh or close the tab **without** selecting
5. Return to the same conversation
6. Complete the pending picker — the turn finishes without a duplicate elicit identity

## Product imports (sample)

```ts
import { createTool } from "@sweatpants/agent-sdk";
import { makePlugin, getElicitContext } from "@sweatpants/framework/chat";

// Tool authoring with elicit
export const bookFlight = createTool("book_flight")
  .description("Book a flight")
  .parameters(/* zod schema */)
  .elicits({ pickFlight: { response: /* schema */ } })
  .execute(function* (params, ctx) {
    const picked = yield* ctx.elicit("pickFlight", { message: "Pick a flight" });
    // ...
  });

// UI binding
export const bookFlightPlugin = makePlugin(bookFlight).onElicit({
  pickFlight: function* (req, ctx) {
    const context = getElicitContext(req);
    // render picker, return accept/decline
  },
});
```

## Automated gate

```bash
pnpm -C packages/framework exec vitest run acceptance/demo-elicit-pause-resume.acceptance.test.ts
```

Classification: **acceptance** (protocol/handler).

The automated suite seeds a real pending interrupt identity, clears the
process-local registry (disconnect boundary), resumes with the **same**
`interruptId`, and asserts turn completion without `TOOL_RESUME_FAILED` or a
minted replacement identity. Complements flight UI e2e for projection.
