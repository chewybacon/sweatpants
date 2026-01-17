---
theme: default
title: "Context is a Fork-Join Problem"
info: |
  ## Lessons from MCP tooling
  Sweatpants Framework
author: Grove Team
keywords: mcp,context,architecture,tooling
class: text-center
highlighter: shiki
drawings:
  persist: false
transition: slide-left
mdc: true
colorSchema: light
---

# Context is a Fork-Join Problem

## What MCP taught us about deterministic flow

<div class="pt-12">
  <span class="px-2 py-1 rounded cursor-pointer bg-gray-100">
    Sweatpants Framework
  </span>
</div>

<div class="abs-br m-6 flex gap-2 text-sm opacity-50">
  architecture | DX | adoption
</div>

---

# The Problem We All Hit

<v-clicks>

**Context rot**: the model forgets, repeats, or hallucinates

**Flow drift**: the model decides what to do next

**Hidden coupling**: tools mutate context implicitly

**Unbounded growth**: token budgets explode

</v-clicks>

---

# The Mental Model

Context is a flame chart of forks and joins.

```mermaid {scale: 0.7}
sequenceDiagram
  participant P as Parent Context
  participant T as Tool Fork

  P->>T: tool entry (fork)
  Note over T: tool work
  T-->>P: tool result (join)
```

---

# Forks Can Fork

```mermaid {scale: 0.7}
sequenceDiagram
  participant P as Parent Context
  participant T as Tool Fork
  participant S as Sub-tool

  P->>T: tool entry (fork)
  Note over T: tool work
  T->>S: sub-tool entry (fork)
  Note over S: sub-tool work
  S-->>T: sub-tool result (join)
  T-->>P: tool result (join)
```

Each fork must join back to its parent.

---

# Micro-Loops

"What is my purpose?" "You pass butter."

```mermaid {scale: 0.45}
sequenceDiagram
  participant P as Parent
  participant B as butter_bot
  participant T as book_flight
  participant L as LLM
  participant U as User

  P->>B: "Book a flight"
  B->>T: { message: "Austin to Vegas" }
  T->>L: sample("parse destination")
  L-->>T: { from: "Austin", to: "Vegas" }
  T->>U: elicit("When?")
  U-->>T: "Friday"
  T-->>B: { status: "done", ticket: "UA-1234" }
  B-->>P: "Done! What else?"
  P->>B: "Book a hotel"
  B->>T: { message: "Book a hotel" }
  T-->>B: { error: "I only book flights" }
  B-->>P: "I can't do that. What else?"
```

<v-click>

Elicits fork right to user. Samples fork right to LLM. All join back.

</v-click>

---

# MCP Gives Us the Primitives

MCP already encodes fork/join.

- `tools/call` = fork into tool
- `elicitation/create` = fork into user
- `sampling/createMessage` = fork into LLM
- `tool_result` = join back to parent

---

# The Business Takeaway

## What is a ButterBot?

A micro-chat with one purpose.

- Controls a loop around a single tool
- Passes messages, props, and history
- Signals success or failure to the parent
- "What else can I help with?"

<v-click>

ButterBot is shared vocabulary:

| Engineering | Design | Business |
|-------------|--------|----------|
| fork-join flow | scoped interaction | predictable cost |

</v-click>

---

# Closing

Context is not a blob. It's a concurrency problem.

<v-click>

MCP gives us the fork/join primitives. Sweatpants shows the discipline.

</v-click>


<div class="mt-12 opacity-50 text-sm">

context is a fork-join problem

</div>
