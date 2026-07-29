# Bounded durability — obsolete compatibility clean cut

## Commit

- `2b79983` — remove obsolete compatibility surfaces without forwarders or conversion paths.

## Deleted surfaces

- Journal Authority snapshot conversion for pre-v4 authority snapshots. The parser accepts only the current exact v4 shape.
- The local-only `markActivationStarted` authority command. Runnable consumption now occurs in canonical activation claim or attachment binding.
- Optional/legacy `RecordedOperationDescriptor.label` and operation-only/string authoring overloads. Recorded operations require a stable `key`; Journal Authority and A2A reject the old descriptor shape.
- Tool Session `LegacyTool*` identities; the current message identities are declared directly.
- Unused MCP `ElicitHandlersFor` alias.
- Durable Chat Runtime's `createChatHandler` forwarding alias and Agent Host's `ChatHandlerConfig` type alias.
- Direct chat model-tool declarations; authored chat tools must use `modelTool()` with explicit result classification.
- Worker context `progress()` alias; `notify()` is the sole canonical tool notification surface.
- Durable Streams `Session`, `SessionStore`, `SessionManager`, and `SessionManagerConfig` interfaces plus their obsolete test-only implementation. `SessionRegistry`/`RecoverableSessionRegistry` remain the sole session lifecycle API.
- Obsolete A2A top-level `protocolVersion` card field. The pinned Inspector's actively required `url` and `preferredTransport` fields remain part of the current external AgentCard contract, alongside authoritative 1.0 `supportedInterfaces`.

No compatibility package, export alias, dual parser, migration function, or forwarding implementation was added.

## Evidence

- Production and test TypeScript checks passed across 24 packages.
- Durable Execution: 23 passed.
- Journal Authority: 92 passed after adding current-format-only parser coverage.
- Tool Session: 104 passed, 7 todo.
- Vite Plugin: 72 passed.
- Durable Chat Runtime: 198 passed, 4 live-only skipped. Fourteen obsolete SessionManager tests were deleted with their API; canonical SessionRegistry coverage remains.
- Tool Runtime Local: 39 source + 6 acceptance passed.
- Agent Host: 37 passed.
- Chat Core: 123 passed after adding direct-tool rejection coverage.
- Platform Acceptance: 84 passed after updating A2A recorded-operation protocol validation.
- yo-chat: 60 passed.
- yo-studio: 8 passed.
- yo-a2a pinned Inspector: 3 passed.
- Live Redis 7.4.8: all 29 Execution Store/Journal Authority suites passed; the ephemeral container was removed.
- Clean build, exports, product surface, and zero-cycle module graph passed.
- Deterministic `pnpm land`: all 19 stages passed in 3m56s.
- Artifact: `.artifacts/landing/2026-07-29T16-11-12-528Z-deterministic/summary.json`.
- Coverage baseline was deliberately refreshed after deleting only the removed SessionManager contract tests; aggregate package coverage increased to 1,247 collected / 1,219 passed with 21 skipped.

## Residue search

Current package/app/script source has zero matches for:

```text
legacy
deprecated
compatibility alias
compatibility shim
backward compat
migrateDurableAuthoritySnapshot
ElicitHandlersFor
markActivationStarted
SessionManagerConfig
```
