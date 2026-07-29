# Redis Execution Store v1 migration note

Status: active production layout for DR-064 / REQ-036.

## Old layout

`createRedisDurableJournalAuthority` stores one complete
`DurableAuthoritySnapshot` at:

```
<keyPrefix>durable-authority:<journalId>
```

Every mutation loads the full snapshot, reconstructs an in-memory authority,
applies a command, and CAS-replaces the full value. Cost and contention therefore
grow with the lifetime of the journal.

## New layout

`createRedisExecutionStore` implements the bounded `ExecutionStore` contract
directly. It does not reconstruct an in-memory authority.

```
<keyPrefix>execution:{<executionId>}:control
<keyPrefix>execution:{<executionId>}:private:<revision>
<keyPrefix>payload:<sha256>
<keyPrefix>replay:<sha256>
```

- `control` is one bounded `ExecutionTreeSnapshot` or `TerminalCapsule` plus its
  per-execution revision. CAS touches this key only.
- `private:<revision>` is written atomically with the corresponding control CAS.
- payload and replay objects are immutable and content-addressed.
- replay objects form an immutable linked chain through opaque
  `DurableReference`s; appending never rewrites prior objects.
- the hash tag around `executionId` keeps control/private keys in one Redis
  Cluster slot.

## Compatibility and rollout

This repository is pre-alpha and carries no compatibility promise. The new
store deliberately performs **no dual read and no state conversion** from the
legacy snapshot key. A deployment adopting v1 MUST start with a fresh key prefix
or delete the legacy prefix before activation. Silently reading old snapshots
would preserve the unbounded model this stage removes.

All production authority consumers use the Execution Store path. The legacy
whole-snapshot Redis implementation, package identity, key writer, and in-memory
authority reconstruction adapter are deleted.

## Certification

The driver MUST pass the same observable store cases as memory, plus live-Redis
cases for:

1. per-execution CAS conflict isolation;
2. atomic control/private-record writes;
3. content-addressed JSON and byte payload round trips;
4. immutable replay append/read ordering;
5. missing payload and replay-object behavior;
6. no legacy snapshot key creation.
