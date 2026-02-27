# Durable Streams Protocol Compliance Matrix

Date: 2026-02-26

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
| Lexicographically sortable offsets | Implemented (zero-padded numeric tokens) | `packages/framework/src/handler/durable/protocol-headers.ts`, handler/smoke tests |

## Mutating Operations

| Capability | Status | Verification |
| --- | --- | --- |
| `PUT /sessions/{id}` stream create/open | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| `POST /sessions/{id}` append | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| `POST /sessions/{id}` close via `Stream-Closed: true` | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| `DELETE /sessions/{id}` delete stream | Implemented | `packages/framework/src/handler/durable/__tests__/handler.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |

## Durability and Storage

| Capability | Status | Verification |
| --- | --- | --- |
| Buffer retention independent of refCount | Implemented | `packages/framework/src/lib/chat/durable-streams/session-registry.ts`, `packages/framework/src/lib/chat/durable-streams/__tests__/session-registry.test.ts`, `packages/framework/src/handler/durable/__tests__/http-smoke.test.ts` |
| In-memory shared storage | Implemented | Durable smoke tests |
| Redis/Postgres backend abstractions | Implemented (adapter interfaces + stores) | `packages/framework/src/lib/chat/durable-streams/redis-store.ts`, `packages/framework/src/lib/chat/durable-streams/postgres-store.ts` |
| Concrete Redis/Postgres clients + integration tests | Pending | `sweatpants-e4j` |

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

## Definition of Done (Compliance Hardening Epic)

- [x] Offsets are lexicographically sortable in protocol headers and control payloads.
- [x] Stream retention is decoupled from active reader refCounts.
- [x] Read transport responsibilities are separated from chat orchestration path.
- [x] JSON empty-catch behavior returns `[]` for `Accept: application/json`.
- [x] Protocol-native mutating endpoints (`PUT`/`POST`/`DELETE`/close) are implemented and tested.
- [ ] Concrete Redis/Postgres runtime adapters and integration tests are complete (`sweatpants-e4j`).
- [ ] Final compliance review against upstream protocol examples is documented.
