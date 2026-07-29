# Bounded durability closure — Cut 4 landing record

## Commits

- `588e4c9` — move remaining Session Contract ownership into Journal Authority, Workspace Runtime, Tool Session, and destination testing surfaces; delete `session-contract`.
- `fdb4024` — switch production Turn and Program authority composition to the bounded Execution Store, rename the Redis driver, delete the whole-snapshot Redis authority, and add certification tooling.
- `fd154eb` — compact authority control state and archive completed Turn journals as immutable replay objects.
- `5451b97` — preserve the final real-Redis 10/100/1,000 certification artifact.

## Ownership and package closure

- Journal Authority owns capability signing/fencing, authority declarations and implementation, shared conformance, schema validation, `ExecutionStorePort`, the sole conflict-classified commit loop, stored authority composition, and Turn terminal/publication authority.
- Workspace Runtime owns sandbox/workspace contracts and distributed-host conformance through `./testing`.
- Tool Session owns durable MCP invocation and transport contracts.
- Durable Execution retains ProgramDriver conformance through `./testing`.
- `packages/session-contract` and every source, manifest, project-reference, lockfile, and current-document package string are deleted.
- `packages/journal-authority-redis` and `@sweatpants/journal-authority-redis` are deleted and atomically replaced by `packages/execution-store-redis` / `@sweatpants/execution-store-redis`.

## Production persistence switchover

`createStoredDurableJournalAuthority` delegates storage exclusively to `ExecutionStore` operations. `runExecutionCommitLoop` loads the winning revision, evaluates authority semantics, commits under expected revision, and retries only explicit storage conflicts inside the calling Effection scope. Infrastructure failures propagate unchanged.

Production durable chat installs one composition-owned Execution Store for both Turn publication and Program authority. yo-chat selects Redis or development memory once and cannot mix stores during a process lifetime. Tool Runtime Local's durable facade also reaches authority persistence through the Execution Store.

Completed sibling Turns are removed from active authority snapshots. Their semantic records append to immutable replay objects; active recovery uses the narrow task-tree query and does not read completed-Turn journals. Explicit diagnostic trace reads may join the archive without placing it back in mutable control state.

## Redis v1 layout and migration policy

The final Redis adapter stores:

```text
<keyPrefix>execution:{<executionId>}:control
<keyPrefix>execution:{<executionId>}:private:<revision>
<keyPrefix>payload:<sha256>
<keyPrefix>replay:<sha256>
```

The old Redis authority implementation, full-journal CAS script, old key writer, package export, and adapter-side in-memory authority reconstruction are absent. The rollout policy in `docs/migrations/redis-execution-store-v1.md` is final: use a fresh v1 prefix or delete the obsolete prefix before activation. There is no dual read, online conversion, compatibility package, or legacy fallback.

## Narrow evidence

- Journal Authority: 91 passed across 13 suites, including the same 18-case corpus over direct memory authority and memory Execution Store composition.
- Live Redis: 29 passed across three suites:
  - 6 Execution Store cases;
  - 4 distributed-host/sandbox cases;
  - 19 Journal Authority cases, including explicit backend identity.
- Durable Chat Runtime: 212 passed, 4 live-only skipped.
- Tool Runtime Local: 39 source tests and 6 acceptance tests passed.
- yo-chat: 60 passed across 17 suites.
- Platform/package/application coverage passed through deterministic landing.

## Fail-closed Redis evidence

Running `pnpm certify:bounded-storage` without `REDIS_URL` exited nonzero with:

```text
REDIS_URL is required; bounded storage certification never falls back to fake Redis
```

The final live run used an agent-provisioned ephemeral Docker `redis:7-alpine` instance reporting Redis `7.4.8`. `REDIS_URL` and `REDIS_REQUIRED=1` were explicit. The container was stopped and removed after evidence was copied into the repository.

## 10/100/1,000 boundedness certification

Command:

```text
REDIS_URL=redis://127.0.0.1:<ephemeral-port> REDIS_REQUIRED=1 pnpm certify:bounded-storage
```

Committed machine-readable evidence:

- `docs/landing/evidence/bounded-storage-cut-4.json`
- source artifact: `.artifacts/certification/bounded-storage-2026-07-29T13-46-00-587Z.json`

For both memory and real Redis at 10, 100, and 1,000 completed Turns:

- completed-execution reads during active restore: `0`;
- unrelated-execution writes: `0`;
- records scanned: `1`;
- memory resume bytes: `1073`, `1074`, `1075`;
- memory mutation bytes: `734`, `735`, `736`;
- Redis resume bytes: `1072`, `1073`, `1074`;
- Redis mutation bytes: `809`, `811`, `813`;
- history page entries: `10`, `50`, `50`;
- history page bytes: `321`, `1681`, `1681`;
- Redis command count for active restore/mutation: `4` at every size;
- Redis command/payload bytes: `4123`, `4128`, `4133`;
- real keys identify only the active execution control and newly appended replay object.

Control/replay cost remains effectively constant as completed-Turn count grows.

## Residue, graph, exports, and build gates

```text
packages/session-contract                                      => absent
packages/journal-authority-redis                               => absent
@sweatpants/session-contract in source/manifests/lockfile      => 0
@sweatpants/journal-authority-redis in source/manifests/lock   => 0
legacy Redis reconstruction/snapshot symbols in final adapter => 0
package cycles                                                 => 0
production module cycles                                       => 0
architecture violations                                        => 0
scripts/module-graph-baseline.json                              => []
```

- Root production typecheck passed.
- Strict tests typechecked in 24 packages.
- All application typechecks passed.
- Clean from-scratch build passed.
- Exports validated for 25 packages.
- Product surface and generated reviewer artifact verification passed.
- Deterministic `pnpm land`: all 19 stages passed in 3m29s.
- Landing artifact: `.artifacts/landing/2026-07-29T13-46-26-256Z-deterministic/summary.json`.

## Status

**Cut 4 complete.** Bounded memory/Redis Execution Store composition is the only production authority persistence path, completed work is external to active control state, legacy Redis persistence and Session Contract are deleted, live Redis and 10/100/1,000 evidence pass, and the repository graph remains closed.
