# `@sweatpants/crank-store-redis`

Redis-backed `CrankStore` for replay-crank journals, commands, fenced ownership,
and processless parking.

The store persists each session journal and coordination record through an atomic
compare-and-set Lua transaction. A Redis set records sessions that require an
activation. The set entry remains present while a turn is running and is removed
only after a successful park or close, so an expired owner can be rediscovered.

```ts
const store = createRedisCrankStore(redisClient);
```

A production host must consume `store.runnableSessions()` after startup and from
its durable activation worker, resolve the application runtime for each session,
and call `runtime.activate(sessionId)`. The host ownership coordinator—not the
crank—renews active leases with `store.renewLease()` or performs fenced takeover
after hard process loss. Duplicate delivery remains safe because journal appends
validate the owner epoch. Pub/sub notifications are only a latency optimization;
the Redis runnable set is the durable recovery source.

The in-memory store remains the local/test reference implementation.
