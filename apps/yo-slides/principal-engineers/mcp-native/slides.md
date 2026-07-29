---
theme: default
title: "MCP-Native: Tools That Live Inside Your App"
info: |
    ## Sweatpants Framework
    Comfy. Powerful. BTW, I use Arch.
author: Grove Team
keywords: mcp,tools,react,generators
class: text-center
highlighter: shiki
drawings:
    persist: false
transition: slide-left
mdc: true
colorSchema: light
---

# MCP-Native

## Tools That Live Inside Your App

<div class="pt-12">
  <span class="px-2 py-1 rounded cursor-pointer bg-gray-100">
    Sweatpants Framework
  </span>
</div>

<div class="abs-br m-6 flex gap-2 text-sm opacity-50">
  comfy | powerful | btw i use arch
</div>

---

# Canonical Tools + Plugins

Tools are authored once with `@sweatpants/agent-sdk`.
Browser UI is attached with plugin elicit handlers.

```ts
const pickCardTool = createTool("pick_card")
    .description("Draw cards and let the user pick one")
    .parameters(z.object({ count: z.number() }))
    .elicits({ pickCard })
    .execute(function* (params, ctx) {
        const cards = drawCards(params.count);
        const picked = yield* ctx.elicit("pickCard", {
            message: "Pick a card",
            context: { cards },
        });

        if (picked.action !== "accept") return { success: false };
        return { success: true, picked: picked.content.card };
    });
```

---

# Browser UI Lives In A Plugin

```ts
const pickCardPlugin = makePlugin(pickCardTool)
    .onElicit({
        pickCard: function* (request, ctx) {
            const response = yield* ctx.render(CardPicker, request.context);
            return { action: "accept", content: response };
        },
    })
    .build();
```

The tool controls the durable flow.
The browser controls the UI for declared elicit keys.

---

# Let's Build `book_flight`

User wants to book a flight. The tool needs to:

1. Search for flights
2. Let the user pick a flight with UI
3. Let the user pick a seat with UI
4. Get a travel tip from the model
5. Return confirmation

---

# One Durable Tool Session

```ts
const bookFlightTool = createTool("book_flight")
    .parameters(BookFlightParams)
    .elicits({ pickFlight, pickSeat })
    .samples()
    .execute(function* (params, ctx) {
        const flights = yield* searchFlights(params);

        const flight = yield* ctx.elicit("pickFlight", {
            message: "Select a flight",
            context: { flights },
        });
        if (flight.action !== "accept") return { success: false };

        const seat = yield* ctx.elicit("pickSeat", {
            message: "Select a seat",
            context: { flight: flight.content.flightId },
        });
        if (seat.action !== "accept") return { success: false };

        const tip = yield* ctx.sample({ prompt: "Give a short travel tip" });
        return { success: true, flight: flight.content, seat: seat.content, tip: tip.text };
    });
```

---

# Why This Is MCP-Native

- Tool metadata projects to MCP cleanly.
- Elicit requests map to user input capability.
- Sample requests map to model sampling capability.
- The same tool can run locally, in a worker, over MCP, or in AgentCore.
- React UI remains an app/plugin concern.

---

# Mental Model

```txt
createTool(...)
  declares parameters, elicits, samples
        │
        ▼
Runtime session executes generator
        │
        ├─ ctx.elicit(...) → plugin UI
        ├─ ctx.sample(...) → model provider
        └─ return result → model-visible tool result
```

---

layout: center
class: text-center

---

# One Tool Ontology

Core tools everywhere.
Plugins for browser interaction.
Runtime adapters for placement.
