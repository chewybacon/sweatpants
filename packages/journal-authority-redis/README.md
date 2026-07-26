# @sweatpants/journal-authority-redis

Redis-backed ProgramDriver durable journal authority.

```ts
import { createRedisDurableJournalAuthority } from "@sweatpants/journal-authority-redis";

const authority = createRedisDurableJournalAuthority(redisClient, {
    journalId: "conversation:123",
    keyring,
    schemaRegistry,
});
```

The adapter persists canonical authority snapshots behind Redis CAS. Capability keys and runtime
Standard Schema validators remain process-local. Every CAS retry reloads the winning snapshot and
reruns validation and mutable-state verification before append.
