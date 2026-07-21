# Coverage Parity Map: yo-chat Outside-In → @sweatpants/framework-acceptance

Status: v1 — records what the framework-acceptance leaf now certifies, what was
removed, and what deliberately stays app-owned. Required by the test-rig
specification (REQ-045) before any generic yo-chat coverage is deleted.

## Removed in this change

| Removed | Replacement | Evidence |
|---|---|---|
| `apps/yo-chat/src/outside-in/spikes/openai-responses-simulator.ts` | `@sweatpants/test-rig` model simulator (`packages/test-rig/src/model.ts`) | Expectation-shaped barriers, manual chunk release, tool calls, unexpected-request poisoning, unanswered-request verification — all with direct tests (`model.test.ts`) |
| `apps/yo-chat/src/outside-in/spikes/interactive-chat-conversation.ts` | `rig.chat` conversation/turn/elicit barriers (`packages/test-rig/src/chat.ts`) | Conversation identity, sequential turns, one-shot elicit actions, turn-scoped transcripts |
| `apps/yo-chat/src/outside-in/spikes/openai-simulator-tracer.test.ts` | `packages/framework-acceptance/src/interactive-tool.acceptance.test.ts` + `history.acceptance.test.ts` | Same causal scenario (tool call → 2 elicits → nested sample → result → final response → second turn) against **both** in-process and loopback HTTP bindings; history assertions are stronger (normalized causal ordering + nested-sample exclusion instead of substring checks) |
| yo-chat devDependency `@simulacrum/foundation-simulator@0.8.0` | dependency of `@sweatpants/test-rig` only | Simulator is package-owned infrastructure |

The spike-era additions to `apps/yo-chat/src/outside-in/lib/driver.ts`
(async elicit responders, async turn sources) remain: they are generic driver
capabilities now also used by non-spike flow tests.

## Framework behavior now certified by the leaf (hermetic, gates `pnpm land`)

| Behavior | framework-acceptance test | Bindings |
|---|---|---|
| Streamed text with causal delta pacing (release → observe → finish → complete) | `streaming.acceptance.test.ts` | in-process + HTTP |
| Outer tool call through real pi-ai/OpenAI parser with pull-ID correlation | `interactive-tool.acceptance.test.ts` | in-process + HTTP |
| Two named public elicitations parked/resumed through real client session | `interactive-tool.acceptance.test.ts` | in-process + HTTP |
| Nested tool-owned `ctx.sample()` through real provider boundary, off-main-thread worker proof | `interactive-tool.acceptance.test.ts` | in-process + HTTP |
| Two-turn history: prior user msg, outer tool call, tool result, terminal assistant text exactly once, in causal order | `history.acceptance.test.ts` | in-process + HTTP |
| Nested-sample prompt/response excluded from outer history (non-vacuous) | `history.acceptance.test.ts` | in-process + HTTP |

## Retained yo-chat outside-in coverage and why it stays

| Suite | App-owned boundary it certifies |
|---|---|
| `flows/book-flight.flow.test.ts` | Live-model Tier A/B: real Copilot provider behavior, generated `tool-registry.gen.ts` wiring, app worker bundle |
| `flows/play-ttt.flow.test.ts` | Durable crank-native program (`play_ttt`) through app-generated program worker |
| `flows/multi-turn.flow.test.ts` | Live-model multi-turn against app composition |
| `flows/cancel-open-elicit.flow.test.ts` | Cancel-on-send against app composition |
| `worker-boundary.test.ts` | Vite/`?modulePath` worker bundling boundary — explicitly out of test-rig scope |
| `e2e/*` (Playwright) | Browser rendering, plugin UI, route composition |

These are live-model or bundler/browser suites; the deterministic leaf does not
replace them (design Non-Goals). Removal of any of them requires a new entry
in this map first.

## Not yet migrated (candidates for a later parity round)

- Generic elicit decline/cancel outcome variants (currently only live-model).
  Candidate: extend `interactive-tool.acceptance.test.ts` with decline/cancel
  branches before touching the live suites.
