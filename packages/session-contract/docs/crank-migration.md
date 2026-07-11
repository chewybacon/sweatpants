# Replay-crank migration traceability

| Former behavior scenario | Replay-crank coverage |
|---|---|
| Plain streamed turn | `session-contract` crank effect/emission tests; framework AG-UI conformance normal run |
| Multiple tool calls | crank hierarchical child/`all` test; framework AG-UI tool conformance |
| Tool-internal elicit and resume | crank processless elicit replay test; durable handler interrupt conformance |
| Process loss / fresh generator | `restartAfterResolution` crank test and factory-count assertion |
| Reconnect from cursor | durable public projection and existing durable handler reconnect suites |
| Turn cancellation | crank command/task outcome implementation; cancellation command uses fresh replay activation |
| Model/tool error | replayable error `pull_resolved`; durable handler error and tool validation suites |
| Multi-turn conversation | ordered `send` command consumption and per-turn root IDs |

Obsolete mechanics: wait sequence records, fold action selection, serialized
transcript/call-batch checkpoints, call reattachment, body/fold authoring modes,
and timer-based log polling. They are intentionally not compatibility-tested.

AG-UI is now an adapter over durable public events. Interrupted streaming
attempts project an explicit `ATTEMPT_ABANDONED` reset/error frame before
replacement output; tests must not expect abandoned partial text to remain.
