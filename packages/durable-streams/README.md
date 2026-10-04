# @sweatpants/durable-streams

Internal durable stream protocol primitives extracted from `@sweatpants/agent-host`.

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

`TokenBuffer.read(afterLSN, limit?)` returns at most `limit` tokens when supplied;
`lsn` remains the stream's tail, not the end of that batch. Advance a reader by
the number of tokens actually consumed. `createPullStream` reads batches of 256
only when demanded and releases consumed payload references. It remains an
Effection pull stream; batching does not create a background reader.

The Redis adapter stores token LSNs as Redis stream IDs so bounded reads seek
directly to the reconnect offset. Its `lsn-v1` response-buffer format rejects
older buffers with an explicit key-reset diagnostic. This concerns transient
response delivery, not the execution journal.

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
yield *
    setupDurableStreams({
        bufferStore,
        registryStore,
        retentionPolicy: { mode: "retain_until_ttl", ttlMs: 60_000 },
    });
```

## Integration Pattern (Framework Consumer)

```ts
import {
    createProtocolReadResponse,
    createProtocolMutationResponse,
    parseOffsetParam,
    parseLiveMode,
    parseTimeoutMs,
} from "@sweatpants/durable-streams";
```

The framework durable handler owns chat/provider orchestration and passes protocol-level context/stores to these helpers.

## Migration Notes

Moved modules:

- `packages/durable-chat-runtime/src/durable-handler/protocol-headers.ts`
- `packages/durable-chat-runtime/src/durable-handler/read-transport.ts`
- `packages/durable-chat-runtime/src/durable-handler/mutation-transport.ts`
- `packages/durable-chat-runtime/src/durable-handler/sse-formatter.ts`
- `packages/durable-streams/src/types.ts` (core type source)
- `packages/durable-streams/src/in-memory-store.ts` (core in-memory source)

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
