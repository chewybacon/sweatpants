# Elicit Use Cases

This document describes key use cases for the elicit system, capturing design decisions and architectural implications.

## 1. Multiple Agents Sharing Same Elicit

**Scenario:** Multiple agents (e.g., Chat, Flight, Hotel) all need to elicit user input, and they share a common implementation (e.g., the same React UI component in a chat interface).

**Behavior:**

- Single implementation serves all agents — the UI has one `elicit` implementation that handles requests from any agent
- Queueing by default — if multiple agents elicit concurrently, requests queue up
- UI controls queue behavior — could show one at a time, stack them, or merge
- Context flows through — coroutine context is available at invocation time, so the implementation can access agent identity, labels, and metadata for attribution/styling

**Example:**

```ts
// Program level - one implementation serves all
yield* ElicitProtocol.implement(chatUIElicit);

// Any agent can call it
const Chat = createAgent({
  askQuestion: createTool("ask").execute(function* () {
    yield* elicit({ message: "..." }); // uses shared impl
  }),
});

const Flight = createAgent({
  selectFlight: createTool("select").execute(function* () {
    yield* elicit({ message: "..." }); // same shared impl
  }),
});
```

---

## 2. Agent Asking User for Input via Chat

**Scenario:** The "happy path" — agent is running, needs user input, sends an elicit that renders in the chat UI, user responds, agent continues.

**Behavior:**

- Typed elicit components — each elicit type has a schema (input/output) and a corresponding UI component
- Calling coroutine suspends — the specific coroutine that called `yield* elicit(...)` is suspended; other coroutines can continue
- User can go "off-script" — if user ignores the structured elicit and types something else, it returns `{ action: 'other', content: '...' }`

**Handling "other" responses:**

```ts
yield* around({
  *elicit([args], next) {
    const result = yield* next(args);

    if (result.action === "other") {
      // Common handling: interpret via model
      const interpretation = yield* sample({
        prompt: `User responded with: "${result.content}"
                 Expected: structured input for ${args.schema}
                 What did they mean?`,
      });
      // Could re-elicit, transform result, etc.
    }

    return result;
  },
});
```

---

## 3. MCP Invoking Tool Which Causes Elicit in Chat

**Scenario:** An external MCP client (e.g., Claude Desktop) calls a tool exposed via MCP. That tool's execution triggers an elicit which renders in a chat UI and returns the result back through MCP.

**Behavior:**

- Transport bridges MCP and UI — the agent sits between MCP (tool invocation) and UI (elicit rendering)
- MCP blocks on elicit — from the MCP client's perspective, the tool call is in-flight until the human completes the elicit
- Agent code unchanged — the same tool code works whether invoked via MCP, HTTP, or directly

**Architectural implication:**

```ts
// This tool works whether invoked via MCP, HTTP, or directly
const Flight = createAgent({
  bookFlight: createTool("book-flight").execute(function* () {
    // Don't know/care if this came from MCP
    const selection = yield* elicit({
      message: "Select a flight",
      schema: FlightSelectionSchema,
    });
    // Don't know/care that this rendered in a web chat UI
    return Ok(selection.content);
  }),
});
```

---

## 4. Elicit Location

**Scenario:** The agent needs the user's location — accessing device GPS rather than asking them to type it.

**Behavior:**

- Device API access via elicit — a different category of elicit that accesses device capabilities
- Distinct elicit type — has its own implementation that calls browser's geolocation API
- Permission denial is an action — `{ action: 'denied' }`, not an error (consistent with expected outcomes vs. unexpected failures)

**Framework-provided elicit type:**

```ts
import { createElicit } from "@sweatpants/agent";

export const locationElicit = createElicit({
  name: "location",
  description: "Request user location from device GPS",
  input: z.object({ accuracy: z.enum(["high", "low"]) }),
  output: z.object({ lat: z.number(), lng: z.number() }),
  actions: ["accept", "denied", "cancel"],
});
```

**Usage:**

```ts
const location = yield* locationElicit({ accuracy: "high" });

if (location.action === "denied") {
  yield* notify("Location access was denied. Please enter your city manually.");
  // Fall back to text input
}
```

---

## 5. Elicit Clipboard (Read and Write)

**Scenario:** The agent wants to read from or write to the user's clipboard.

**Behavior:**

- Both read and write supported — two separate elicit types
- Framework-provided — standard elicit types with documented schemas

**Elicit types:**

```ts
export const clipboardWriteElicit = createElicit({
  name: "clipboard-write",
  description: "Copy text to user clipboard",
  input: z.object({ text: z.string() }),
  output: z.object({ success: z.boolean() }),
  actions: ["accept", "denied"],
});

export const clipboardReadElicit = createElicit({
  name: "clipboard-read",
  description: "Read text from user clipboard",
  input: z.object({}),
  output: z.object({ text: z.string() }),
  actions: ["accept", "denied", "cancel"],
});
```

**Use cases:**

- Write: Agent completed a booking → copies confirmation code to clipboard
- Read: Agent asks "paste what you copied" → reads clipboard to process content

---

## 6. Elicit Draw a Card (Backend-Authoritative Interactions)

**Scenario:** A card game or similar interaction where the backend controls state and the frontend presents.

**Key insight:** This highlights the frontend-backend coordination pattern where the backend is authoritative.

**Behavior:**

- Backend controls state — what cards exist, which are available, validation
- Frontend controls presentation — visual deck, animation, user interaction
- System picks — the backend randomly selects, frontend just reveals/animates

**Pattern:**

```
Backend (Agent)                         Frontend (UI)
─────────────────                       ─────────────

1. Agent has deck state
2. Agent draws card (random)
3. yield* elicit({
     type: 'reveal-card',        ──────► 4. Receives card to reveal
     card: { suit, value }               5. Animates card draw
   })                                    6. User sees/acknowledges
                            ◄──────────  7. Returns { action: 'accept' }
8. Agent continues
```

**Architectural principle:** Not all elicits are "asking for input" — some are "presenting and waiting for acknowledgment" while the backend maintains authoritative state.

**Security:** The backend never trusts the frontend for authoritative state. Validation, authorization, and state management always happen server-side.

---

## 7. Elicit Choice + Type Something

**Scenario:** A compound elicit — user picks from options AND can type additional input. Common pattern: "Here are your options, or tell me something else."

**Behavior:**

- Single elicit, compound schema — one elicit type = one UI component
- Explicit "custom input" option — distinct from `action: 'other'` (designed option vs. off-script)

**Example:**

```ts
const choiceOrInputElicit = createElicit({
  name: "choice-or-input",
  description: "User selects from options or provides custom input",
  input: z.object({
    message: z.string(),
    choices: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
      })
    ),
  }),
  output: z.discriminatedUnion("type", [
    z.object({ type: z.literal("choice"), value: z.string() }),
    z.object({ type: z.literal("custom"), text: z.string() }),
  ]),
});

// Usage
const result = yield* choiceOrInputElicit({
  message: "How would you like to pay?",
  choices: [
    { label: "Credit Card", value: "cc" },
    { label: "PayPal", value: "paypal" },
    { label: "Bank Transfer", value: "bank" },
  ],
});

if (result.action === "accept") {
  if (result.content.type === "choice") {
    // User picked an option
  } else {
    // User typed something custom
  }
}
```

**Distinction from `action: 'other'`:**

| Scenario                              | How it's captured                                          |
| ------------------------------------- | ---------------------------------------------------------- |
| User picks from choices               | `{ action: 'accept', content: { type: 'choice', value } }` |
| User types in the "other" field       | `{ action: 'accept', content: { type: 'custom', text } }`  |
| User ignores elicit, types in chat    | `{ action: 'other', content: '...' }`                      |
| User clicks X / dismisses             | `{ action: 'cancel' }`                                     |
| User clicks "No thanks" button        | `{ action: 'decline' }`                                    |

---

## 8. Side Quest Without Losing Context

**Scenario:** User is mid-flow with an agent, but wants to do something else temporarily (ask a different question, check something) then return to where they were.

**Behavior:**

- Coroutine tree, not stack — the suspended elicit is a node in a tree, not lost when user forks
- Lossless return — when side quest completes, user returns to the exact pending state
- Auto-return on completion — default behavior when side quest coroutine completes
- Optional explicit navigation — power users can choose which pending context to return to

**Pattern:**

```
Main flow                          Side quest
──────────                         ──────────

1. Agent asks about flight
2. User selecting dates
3. yield* elicit(dateSelection)
        │
        │ ◄── User: "Wait, what's the weather in Tokyo?"
        │
        ├─────────────────────────► 4. Fork: new coroutine
        │ (suspended, not lost)        5. Weather agent responds
        │                              6. User: "Ok thanks"
        │                              7. Coroutine completes
        │ ◄────────────────────────────┘
        │
        ▼ (resume exactly here)
4. User completes date selection
5. Agent continues booking
```

**Fork triggers:**

- Explicit: User says "hold on" or clicks a "pause" action
- Implicit: User starts talking about something different (system/agent detects tangent)

**Nesting:** Forks can nest — side quest within a side quest forms a stack

**UI representation:**

```
┌─────────────────────────────────────────────────┐
│ Chat UI                                         │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │ Pending: Flight booking (selecting dates)   │ │ ◄── User can tap to return
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Weather Agent: Tokyo will be 72°F next week... │
│                                                 │
│ [Type a message...]                             │
└─────────────────────────────────────────────────┘
```

**Architectural requirements:**

1. Serializable coroutine state — design for persistence from the start (required by 1.0)
2. Context tree, not just stack — support both LIFO (default) and explicit navigation
3. Fork/forward/back primitives — core capability shared with parent agents managing subagent state

---

## Cross-Cutting Themes

These use cases reveal several architectural principles:

1. **Protocol pattern** — Declaration (schema) separate from implementation (environment-specific)

2. **Backend authoritative** — Validation, authorization, state management always server-side

3. **Context flows through** — Coroutine context available at every point for attribution, middleware, etc.

4. **Actions vs errors** — Expected outcomes (decline, cancel, denied, other) are actions, not exceptions

5. **Serialization-ready** — Design for persistence from the start

6. **Single implementation, multiple callers** — One elicit implementation serves all agents; queueing handles concurrency
