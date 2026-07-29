# Bounded durability closure — Cut 3 landing record

## Commits

- `7403187` — atomic `core` → `agent-sdk` rename.
- `16781c6` — atomic `framework-acceptance` → `platform-acceptance` rename.
- `64ece9e` + `41b0521` — move `x-elicit-context` into Tool Session and delete the standalone package/lock entries.
- `e6c3317` — complete destination ownership, create Agent Host, delete Framework, and close the module graph.

## Destination stages

### 3A — Tool Session

Moved the MCP protocol codecs, request parser, SSE formatting, handler/session manager, bridge runtime, plugin contracts/registry, mock runtime, examples, tests, tool parameter validation, runtime contract/port, strategy runtime, and inventory projection into `@sweatpants/tool-session`.

Tool Session now publishes explicit `./mcp`, `./chat-runtime`, `./tool-parameters`, `./tool-inventory`, `./foreign`, and `./elicit-context` subpaths. Both tool runtimes consume Tool Session and durable hubs without production imports from Chat Runtime or Agent Host.

### 3B — Durable Chat Runtime

Moved the complete durable handler, ProgramRuntime chat engine, Journal Authority adapter, local Program host, schema adapter, model-sampling relay, tool adapter, plugin-session manager, activation lease integration, Host/Turn scope seam, response-stream integration, runtime contexts, and their tests into `@sweatpants/durable-chat-runtime`.

The runtime publishes owned subpaths directly and no destination imports or forwards Framework.

### 3C — Agent Host

Created `@sweatpants/agent-host` and moved server ingress, application lifecycle, graceful shutdown, standard A2A composition, agent profiles/connections/card signing, enterprise HTTP, server testing adapters, deployment descriptors, Host recovery coordination, and Pino logging integration into it.

The former Framework server module cycle was broken by extracting `agent-profile-types.ts` as a leaf.

### 3D — React Chat

Moved browser rendering contexts, emission helpers/runtime, browser tool runtime, MCP plugin executor, and their tests into `@sweatpants/react-chat`. Production React Chat now imports Chat Core and Tool Session directly and has no Framework dependency or peer.

### 3E — Renames

The earlier atomic Agent SDK and Platform Acceptance renames remain the authoritative package identities. Old directories, manifests, imports, project references, generated artifacts, and lockfile entries are absent.

### 3F — Framework deletion

Deleted `packages/framework`, its manifest/configuration/docs, compatibility barrels, obsolete adapters, dead helper files, package exports, project references, dependencies, peer dependencies, lockfile importer, and all source consumers.

## Production and residue searches

```text
packages/framework directory                                      => absent
@sweatpants/framework in package/app TS/TSX/manifests/lockfile    => 0
packages/framework in package/app TS/TSX/manifests/lockfile       => 0
destination imports from Framework                                => 0
package cycles                                                    => 0
production module cycles                                          => 0
scripts/module-graph-baseline.json                                 => []
```

No forwarding package, forwarding manifest, compatibility export path, source alias, or stale package peer remains. Current documentation and policy examples use destination package names; historical landing records remain historical evidence.

## Narrow evidence

- Tool Session: 102 passed, 7 todo.
- Durable Chat Runtime: 212 passed, 4 explicitly live-only skipped.
- Agent Host: 37 passed.
- React Chat: 17 passed, including rendering and hook-state acceptance.
- Platform Acceptance: 84 passed across 17 suites.
- Chat Core: 122 passed after relocating the 47 non-vacuous history/NDJSON/authoring assertions from Framework.
- Tool Runtime Local: 39 source tests plus 6 acceptance tests passed.
- Tool Runtime AgentCore: 44 passed.
- yo-chat: 60 passed.
- Deterministic browser E2E: all four scenarios passed.

## Graph, exports, build, and landing

- Root production typecheck passed.
- Strict test typecheck passed for 25 packages.
- All application typechecks passed.
- Clean from-scratch workspace build passed after removing destructive nested dependency builds.
- Package export validation passed for 26 packages.
- Product-surface validation passed with 17 facade paths, two product apps, and one golden suite.
- Module graph passed with zero package cycles, zero module cycles, zero architecture violations, and baseline exactly `[]`.
- Repository format, lint, generated reviewer artifact, package/application suites, and deterministic E2E passed.
- `pnpm land`: all 19 stages passed in 3m13s.
- Artifact: `.artifacts/landing/2026-07-29T12-21-54-404Z-deterministic/summary.json`.

## Live-storage evidence

Cut 3 changed package ownership and composition, not the Redis execution-store format or production persistence switchover. Live Redis certification remains a Cut 4 gate and no fake or earlier run is substituted here.

## Status

**Cut 3 complete.** Tool Session, Durable Chat Runtime, Agent Host, and React Chat own their target responsibilities; both package renames are complete; Framework has zero consumers and is deleted; and the package/production-module graph is cycle-free with an empty baseline.
