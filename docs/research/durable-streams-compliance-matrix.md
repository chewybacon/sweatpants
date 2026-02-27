# Durable Streams Protocol Compliance Matrix

Date: 2026-02-27

This checklist tracks implemented protocol capabilities and where they are verified.

## Transport and Read Capabilities

| Capability | Status | Verification |
| --- | --- | --- |
| URL-addressable stream reads (`/sessions/{id}`) | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts` |
| Catch-up reads with `offset` | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts` |
| `offset=-1` sentinel | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts` |
| `offset=now` sentinel (NDJSON) | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts` |
| `offset=now` and empty catches in JSON mode (`[]`) | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts` |
| Long-poll mode (`live=long-poll`) | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| SSE mode (`live=sse`) | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| `HEAD` metadata endpoint | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts` |
| `ETag` and `If-None-Match` (`304`) | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts` |
| Lexicographically sortable offsets | Implemented (zero-padded numeric tokens) | `packages/durable-streams/src/protocol-headers.ts`, handler/smoke tests |

## Mutating Operations

| Capability | Status | Verification |
| --- | --- | --- |
| `PUT /sessions/{id}` stream create/open | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| `POST /sessions/{id}` append | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| `POST /sessions/{id}` close via `Stream-Closed: true` | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| `DELETE /sessions/{id}` delete stream | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| DELETE race behavior (long-poll/read/write) | Implemented | `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |

## Durability and Storage

| Capability | Status | Verification |
| --- | --- | --- |
| Retention policy API (`auto_delete_on_close`, `retain_forever`, `retain_until_ttl`) | Implemented | `packages/durable-streams/src/types.ts`, `packages/framework/src/lib/chat/durable-streams/session-registry.ts`, `packages/framework/src/lib/chat/durable-streams/__tests__/session-registry.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| In-memory shared storage | Implemented | Durable smoke tests |
| Redis/Postgres backend abstractions | Implemented (adapter interfaces + stores) | `packages/framework/src/lib/chat/durable-streams/redis-store.ts`, `packages/framework/src/lib/chat/durable-streams/postgres-store.ts` |
| Concrete Redis/Postgres clients + integration tests | Implemented (env-gated integration tests) | `packages/framework/src/lib/chat/durable-streams/node-redis-adapter.ts`, `packages/framework/src/lib/chat/durable-streams/pg-adapter.ts`, `packages/framework/src/lib/chat/durable-streams/__tests__/adapters.integration.test.ts` |

## Interoperability Coverage

External-client-style protocol flow is validated in:

- `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts`
  - create (`PUT`)
  - append (`POST`)
  - catch-up (`GET ?offset=`)
  - long-poll (`GET ?live=long-poll`)
  - SSE (`GET ?live=sse`)
  - close (`POST Stream-Closed: true`)
  - metadata (`HEAD`)
  - delete (`DELETE`)

## Temporary Divergences

| Divergence | Rationale | Compatibility impact | Planned resolution |
| --- | --- | --- | --- |
| Default retention is `auto_delete_on_close`; completed successful streams can disappear before a later `HEAD`/replay | Prevent unbounded memory/storage growth by default in internal deployments | External clients expecting post-close replay must configure `retain_forever` or `retain_until_ttl` | Keep policy configurable now; revisit protocol profile defaults before external publish |
| In-flight writer + `DELETE` can emit internal writer failure logs (`Buffer is closed`) while still returning deterministic HTTP outcomes | `DELETE` now closes and removes stream state immediately to unblock long-poll/readers and prevent stale state | Logs may contain expected race noise; API behavior remains stable (`DELETE=204`, later reads/writes `404`) | Add structured race-specific log code and optional suppression for expected close-after-delete path |
| SSE control payload uses internal field names (`streamNextOffset`, `streamCursor`, `streamClosed`, `upToDate`) rather than freezing an external schema contract | Current field set is stable for framework clients but not yet semver-frozen as public protocol package API | External consumers should treat control payload as provisional until package is externalized | Freeze field schema and publish explicit compatibility table in package docs during publish hardening |

## Definition of Done (Compliance Hardening Epic)

- [x] Offsets are lexicographically sortable in protocol headers and control payloads.
- [x] Retention policy is configurable and defaulted to auto-delete on successful close.
- [x] Read transport responsibilities are separated from chat orchestration path.
- [x] JSON empty-catch behavior returns `[]` for `Accept: application/json`.
- [x] Protocol-native mutating endpoints (`PUT`/`POST`/`DELETE`/close) are implemented and tested.
- [x] Concrete Redis/Postgres runtime adapters and integration tests are complete (`sweatpants-e4j`).
- [x] Temporary protocol divergences are documented with rationale and follow-up.
