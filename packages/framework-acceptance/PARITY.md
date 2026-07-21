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
| `apps/yo-chat/src/__tests__/return-flight-history.test.ts` | `packages/framework-acceptance/src/history.acceptance.test.ts` | The replacement crosses the real client, handler, Program Runtime, pi-ai/OpenAI request projection, worker tool, nested sample, and resume path. It asserts the prior route-bearing call/result in exact causal order and derives the reverse route from retained arguments; no global fetch replacement, sleeps, or state polling. |
| `apps/yo-chat/acceptance/book-flight-program-driver.acceptance.test.ts` | `packages/framework-acceptance/src/interactive-tool.acceptance.test.ts` plus `packages/tool-runtime-local/src/__tests__/foreign-tool-session.integration.test.ts` and `automatic-foreign-child.integration.test.ts` | The rig proves the public in-process path through two elicits and nested sampling; runtime integration tests retain exact foreign start/continue pull-count and replacement-activation assertions. |
| `apps/yo-chat/acceptance/book-flight-strict-parameters.acceptance.test.ts` | `packages/tool-runtime-local/acceptance/strict-tool-parameters.acceptance.test.ts` plus retained `outside-in/flows/book-flight.flow.test.ts` | Runtime acceptance proves invalid input fails before worker/session execution and valid input executes with clone-safe schema projection. The app-owned live flow retains authored book-flight schema and elicitation wiring coverage. |
| `apps/yo-chat/acceptance/model-token-activity-http.acceptance.test.ts` | `packages/framework-acceptance/src/streaming.acceptance.test.ts`, `packages/framework/src/handler/durable/__tests__/handler.test.ts`, and `http-smoke.test.ts` | Rig streaming now asserts exact ordered deltas, release-before-observation, one terminal assistant emission, and absence of per-token journal records on both bindings. Framework handler tests retain session-offset reconnect semantics. |
| `apps/yo-chat/acceptance/calculator-program-driver-http.acceptance.test.ts` | `packages/framework-acceptance/src/interactive-tool.acceptance.test.ts` plus retained `outside-in/worker-boundary.test.ts` and `flows/multi-turn.flow.test.ts` | The rig HTTP binding proves worker tool result → following provider request → terminal response through Program Runtime. The hermetic boundary gate now executes the exact generated `tool-worker.gen.ts` payload through a loader-only source shim and asserts the foreign-effect envelope; the live flow retains model/app composition coverage. |
| `apps/yo-chat/acceptance/demo-mcp-browser-elicit.acceptance.test.ts` | `packages/framework-acceptance/src/interactive-tool.acceptance.test.ts` | Rig scenarios now deliver accept, decline, and cancel through the real client/handler/worker/resume path on both bindings, and assert structured tool output plus terminal outer completion. |
| `apps/yo-chat/acceptance/durable-pick-card-worker.acceptance.test.ts` | `packages/framework-acceptance/src/durable-tool.acceptance.test.ts` | A rig-owned crank-native tool proves deterministic host effect execution, park-time worker shutdown, fresh-worker replay/resume, and terminal completion without importing an app tool. |
| `apps/yo-chat/acceptance/durable-pick-card-http.acceptance.test.ts` | `packages/framework-acceptance/src/durable-tool.acceptance.test.ts` | The same durable scenario runs on both in-process and HTTP bindings, asserts typed elicit context, nested sampling, native child journaling, and absence of foreign-tool fallback. |
| `apps/yo-chat/src/__tests__/pick-card-history.test.ts` | `packages/framework-acceptance/src/durable-tool.acceptance.test.ts` | The follow-up provider request contains exactly one durable call/result pair and excludes nested sample prompt/response text; no fetch replacement, sleeps, or state polling. |

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
| Crank-native durable child: deterministic host effect, nested sample, typed elicit, park, fresh-worker resume, terminal result | `durable-tool.acceptance.test.ts` | in-process + HTTP |
| Durable call/result follow-up history exactly once with nested-sample exclusion | `durable-tool.acceptance.test.ts` | in-process + HTTP |
| Provider rejection, partial failure, disconnect, visible-partial history, and recovery | `provider-failure.acceptance.test.ts` | in-process + HTTP |
| Concurrent stream/failure isolation across conversations | `concurrency.acceptance.test.ts` | in-process + HTTP |
| Ordinary/durable supersession and nested durable cancellation | `cancellation.acceptance.test.ts` | in-process + HTTP |
| Multi-call, mixed ordinary/durable, mixed success/failure, sequential iterations, iteration limit | `tool-loop.acceptance.test.ts` | in-process + HTTP |
| Invalid arguments/output, unknown targets, malformed/split arguments, text-before-tool | `tool-loop.acceptance.test.ts` | in-process + HTTP |
| Post-resume throw, nested sample failure, and final provider failure after tool result | `nested-failure.acceptance.test.ts` | in-process + HTTP |
| Mid-stream disconnect/checkpoint/reconnect with unseen-only replay and one model request | `reconnect.acceptance.test.ts` | HTTP |

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

## Retained external-substrate acceptance

`acceptance/book-flight-program-driver-http.external.acceptance.test.ts` now runs only
when Redis or AgentCore acceptance is explicitly enabled. Its former default
in-memory path is covered by the rig HTTP binding; the file remains for real
external journal/runtime substrates that the rig intentionally does not fake.

## Retained app-owned durable coverage

The `play-ttt` acceptance/outside-in suites remain app-owned. They validate the
specific game program, move loop, generated durable worker bundle, and UI
contract. Framework-acceptance now owns the generic crank-native routing,
parking, replay, sampling, elicitation, and history contracts.

Generic elicit accept, decline, and cancel outcomes are now package-owned.
App-owned live suites remain because they cover model/provider and bundler
composition rather than generic outcome delivery.
