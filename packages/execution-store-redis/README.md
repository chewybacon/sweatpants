# @sweatpants/execution-store-redis

> **Experimental and uncertified. Do not use this package for production authority.**
>
> The current conformance and sandbox tests run against `memory-fake` and print
> `NOT Redis semantics`. They do not certify Redis protocol behavior,
> transaction behavior, restart durability, or multi-host correctness.

This package is retained as a future multi-host adapter candidate. Production
applications use the validated SQLite authority composition instead. The
package may return to production consideration only after its shared
conformance and durability-spine suites pass against a real Redis service with
the real Redis client in the request path.

The intended adapter shape stores one CAS control record per execution,
revision-private records, and immutable content-addressed replay/payload
objects. It owns no Journal Authority transition policy.

```ts
// Experimental evaluation only.
import { createRedisExecutionStore } from "@sweatpants/execution-store-redis";

const store = createRedisExecutionStore(redisClient, {
    keyPrefix: "evaluation:v1:",
});
```

Use a fresh key prefix for every incompatible pre-release format. The adapter
performs no dual reads and no conversion.
