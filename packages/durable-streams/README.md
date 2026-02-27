# @sweatpants/durable-streams

Internal durable stream protocol primitives extracted from `@sweatpants/framework`.

This package contains protocol and storage core pieces used by the framework durable handler:

- protocol header parsing/formatting
- read transport and mutation transport helpers
- SSE formatter
- core durable-stream types
- generic in-memory buffer and registry stores

## API Surface

Primary exports come from `@sweatpants/durable-streams`:

- `parseSessionIdFromPath`, `parseOffsetParam`, `parseLiveMode`, `parseTimeoutMs`
- `createHeadMetadataResponse`, `createProtocolReadResponse`
- `createProtocolMutationResponse`
- `createSSEEventStream`
- `createInMemoryBufferStore`, `createInMemoryRegistryStore`
- `createPullStream`, `writeFromStreamToBuffer`
- `RetentionPolicy`, `DEFAULT_RETENTION_POLICY`

Subpath exports are available for focused imports:

- `@sweatpants/durable-streams/types`
- `@sweatpants/durable-streams/in-memory-store`
- `@sweatpants/durable-streams/protocol-headers`
- `@sweatpants/durable-streams/read-transport`
- `@sweatpants/durable-streams/mutation-transport`
- `@sweatpants/durable-streams/sse-formatter`

## Retention Configuration

Retention is configured by framework setup/session-registry wiring using `RetentionPolicy`:

- `auto_delete_on_close` (default): delete successful completed streams when refCount reaches zero
- `retain_forever`: keep stream metadata and buffer after completion
- `retain_until_ttl`: keep state until TTL expires, then delete

Example:

```ts
yield* setupDurableStreams({
  bufferStore,
  registryStore,
  retentionPolicy: { mode: 'retain_until_ttl', ttlMs: 60_000 },
})
```

## Integration Pattern (Framework Consumer)

```ts
import {
  createProtocolReadResponse,
  createProtocolMutationResponse,
  parseOffsetParam,
  parseLiveMode,
  parseTimeoutMs,
} from '@sweatpants/durable-streams'
```

The framework durable handler owns chat/provider orchestration and passes protocol-level context/stores to these helpers.

## Migration Notes

Moved modules:

- `packages/framework/src/handler/durable/protocol-headers.ts`
- `packages/framework/src/handler/durable/read-transport.ts`
- `packages/framework/src/handler/durable/mutation-transport.ts`
- `packages/framework/src/handler/durable/sse-formatter.ts`
- `packages/framework/src/lib/chat/durable-streams/types.ts` (core type source)
- `packages/framework/src/lib/chat/durable-streams/in-memory-store.ts` (core in-memory source)

New locations:

- `packages/durable-streams/src/protocol-headers.ts`
- `packages/durable-streams/src/read-transport.ts`
- `packages/durable-streams/src/mutation-transport.ts`
- `packages/durable-streams/src/sse-formatter.ts`
- `packages/durable-streams/src/types.ts`
- `packages/durable-streams/src/in-memory-store.ts`

## Deferred Follow-up

Backend hardening for Redis/Postgres adapters remains intentionally deferred to `sweatpants-ftr`:

- retry/timeout strategy hardening
- LISTEN/NOTIFY and pub/sub robustness
- TTL policy enforcement at backend level
- CI service-backed integration coverage
