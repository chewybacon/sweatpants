# Replay-crank migration traceability

| Former behavior scenario        | Replay-crank coverage                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Plain streamed turn             | `session-contract` crank effect/emission tests; framework AG-UI conformance normal run                            |
| Multiple tool calls             | crank hierarchical child/`all` success and failure/cancellation tests; framework AG-UI tool conformance           |
| Tool-internal elicit and resume | synthetic child-program processless replay is covered; real `ToolSession` conversion is explicitly deferred below |
| Process loss / fresh generator  | fresh-generator restart assertions, expired-owner discovery, and crash-boundary follow-up suite                   |
| Reconnect from cursor           | durable public projection and durable handler reconnect suites                                                    |
| Turn cancellation               | parked and active-effect cancellation tests; late results are discarded                                           |
| Model/tool error                | replayable error `pull_resolved`; durable handler error and tool validation suites                                |
| Multi-turn conversation         | ordered `send` command consumption, per-turn root IDs, pick-card history, and return-flight history tests         |
| Production journal durability   | `@sweatpants/crank-store-redis`; Redis is selected whenever yo-chat has a Redis client                            |
| Journal corruption              | strict relationship/identity mutation tests and legacy fold-log rejection                                         |

Obsolete mechanics: wait sequence records, fold action selection, serialized
transcript/call-batch checkpoints, body/fold authoring modes, and timer-based log
polling. They are intentionally not compatibility-tested.

## Explicitly deferred: real tool-session child programs

The framework currently adapts existing `ToolSession` implementations through
`tool.execute` / `tool.resume` effects. This bridge preserves current local,
worker, plugin, and AgentCore behavior while the crank, store, command, and
projection layers are hardened. It is **not** considered process-death-safe child
program replay and does not satisfy the final structured-tool requirements.

A follow-up must replace the bridge with actual registered tool program factories
whose sample, elicit, emission, and external effects are crank pulls. Until that
lands, claims of full nested-tool process recovery are prohibited.

## Streaming migration

AG-UI is an adapter over durable public events. Interrupted attempts project an
attempt-abandonment event. The adapter closes the active text message and emits a
`MESSAGES_SNAPSHOT` before replacement output, removing abandoned partial text
for continuously connected and reconnecting clients.
