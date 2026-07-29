# @sweatpants/execution-store-redis

Redis 7 adapter for the bounded `ExecutionStore` contract.

```ts
import { createRedisExecutionStore } from "@sweatpants/execution-store-redis";

const store = createRedisExecutionStore(redisClient, {
    keyPrefix: "deployment:v1:",
});
```

The adapter stores one CAS control record per execution, revision-private records, and immutable content-addressed replay/payload objects. It owns no Journal Authority transition policy and never reconstructs an in-memory authority.

Deployments must use a fresh v1 key prefix or delete the obsolete prefix before activation. The adapter performs no dual reads and no conversion.
