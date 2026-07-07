# Wait-Based Session Kernel Authoring Contract

## Four portable rules

1. **Effects through `ctx` never re-fire on resume/replay.** Contract-managed waits (`message`, `elicit`, `sample`, `call`) are durable log records and are matched by wait identity.
2. **Anything flowing into an effect payload must be deterministic across re-runs.** Wait identity is `(sessionId, waitSeq)`; nondeterministic effect payloads make future re-execution unsafe.
3. **IO outside `ctx` is at-least-once.** Corollary: a DB transaction must never span a park.
4. **Resolution variance is excluded from effect identity.** A log recorded against local resolvers must restore against remote resolvers for the same declaration map; topology is answer metadata, not wait identity.

## Durability tiers

| Tier | Who reaches it | Substrate persists log? | On process death |
|---|---|---|---|
| Replayable | body-mode + effect journal (future Path A driver) | yes | rehydrate anywhere, resume from journal |
| Checkpointed | fold-mode structurally; body-mode at turn boundaries | yes | resume from message-wait (fold) / last checkpoint with orphaned fates (body) |
| Pinned | anything with live PTYs or unserializable handles | optional | `session_lost`, typed |

Tier is **substrate config × conformance**. Authors do not declare a tier; authoring mode sets the ceiling.

## Fate × mode table

| Pending wait at death | Fold-mode | Body-mode |
|---|---|---|
| message | safe — the wait is the restore point | safe by construction |
| elicit | survives with identity | `orphaned` |
| sample | survives; harness may re-run and answer | `orphaned` |
| call | resolver reattaches, else `session_lost` failure answer | reattach, else `orphaned` + reason `session_lost` |

`answered` is represented by an answer record. Non-answered terminal fates are observable `fate` records: `expired`, `orphaned`, and `cancelled`.

## Capability shape

Capabilities are a closed declaration map: name to input/output schema. Authors declare what they may call; scopes inject how those calls execute. Call-waits record only `{ target, input }`.

## Tool context as agent-context projection

The old sketch's `ToolCtx ⊂ AgentCtx` idea survives as documentation: tool authoring is body-mode over the same wait grammar, while fold-mode agents own the turn loop. Clients use the same session surface either way.
