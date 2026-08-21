# Outside-In HTTP Test Tier

A fast, headless test tier that drives the **real** yo-chat stack through a
universal `fetch(Request) -> Response` seam and asserts on the AG-UI/SSE event
stream — no browser, no DOM, no `networkidle`.

Implements `.pi/specs/outside-in-http-testing-design.md`.

## What it proves

One shared test body runs against **two bindings** of the same seam:

- **Tier A** (`lib/tier-a.ts`) — the durable chat handler in-process, wired to a
  **real worker-backed** tool runtime (a genuine worker thread that loads the
  generated `tool-registry.gen.ts` tool list through the yo-chat bootstrap).
  Fast dev loop; covers handler → adapter → worker → resume.
- **Tier B** (`lib/tier-b.ts`) — the **real booted app server** (`vite dev`) over
  real HTTP, adding the vite `nodeWorkerPlugin` / `?modulePath` worker bundling
  and SSR wiring that Tier A skips.

Both use the **real Copilot-authed model** — no fake model and no scripted model
responses — and assert on robust structural outcomes (tool calls, elicits,
confirmation tokens, terminal states), not model prose.

## Layout

```
src/outside-in/
  lib/
    chat-fetch.ts      # explicit ChatFetch seam and ChatBinding
    transcript.ts      # normalized AG-UI event stream + outcome
    driver.ts          # ChatClient-driven turns, elicit→resume loop, fail-fast timeout
    assertions.ts      # expectToolCalled/expectElicit/expectOutcome/...
    auth.ts            # Copilot auth precheck (fail fast, don't hang)
    flake.ts           # bounded retry on transient errors only (never assertions)
    tier-a.ts          # in-process worker-backed binding
    tier-b.ts          # real-server binding
    server-fixture.ts  # boot/reuse the real server (scrubs VITEST from its env)
    tool-worker-bootstrap.mjs / worker-probe-bootstrap.mjs   # tsx-in-worker shims
    worker-probe.worker.ts   # worker-only marker tool for the boundary test
  worker-boundary.test.ts    # hermetic: proves tools run OFF the main thread
  flows/                     # live-model flows (gated)
    book-flight.flow.test.ts     # pickFlight → pickSeat → TKT- confirmation
    play-ttt.flow.test.ts        # worker sampling + terminal final board
    multi-turn.flow.test.ts      # tool calls across two turns
  global-setup.ts            # boots the Tier B server once when requested
  tiers.ts / flows/tiers.ts  # tier selection + live gating
```

## Running

The tier is **excluded from the hermetic default** `pnpm test` and has its own
config (`vitest.outside-in.config.ts`).

```bash
# Full integration: real Copilot model, Tier A + Tier B, real worker runtime,
# real booted server / vite ?modulePath bundling. This is the main command.
pnpm test:outside-in

# Faster integration loop: real Copilot model + Tier A only.
pnpm test:outside-in:tier-a

# Explicit no-network guard: worker-boundary regression only.
pnpm test:outside-in:hermetic
```

`pnpm test:outside-in` sets `RUN_LIVE=1` and `OUTSIDE_IN_TIER_B=1`, so it runs
real integration coverage by default. Missing/expired Copilot auth is a failure,
not a skip. Unmarked manual Vitest runs still skip live flows unless `RUN_LIVE=1`
is present, and `pnpm test:outside-in:hermetic` never touches the network.

### Environment knobs

| Var                          | Default                    | Meaning                                                                               |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| `RUN_LIVE`                   | set by `test:outside-in`   | `1` enables live-model flows; missing auth fails fast                                 |
| `OUTSIDE_IN_TIER_B`          | set by `test:outside-in`   | `1` also runs Tier B (boots the real server)                                          |
| `OUTSIDE_IN_SERVER_PORT`     | `8123`                     | Tier B server port                                                                    |
| `OUTSIDE_IN_REUSE_SERVER`    | unset                      | `1` reuse an already-running server (never killed)                                    |
| `OUTSIDE_IN_SERVER_URL`      | unset                      | point Tier B at an existing server URL                                                |
| `OUTSIDE_IN_SERVER_LOGS`     | unset                      | `1` streams Tier B server logs; otherwise logs are captured and shown only on failure |
| `OUTSIDE_IN_FLOW_TIMEOUT_MS` | `90000`                    | hard cap for a whole headless flow before failing                                     |
| `OUTSIDE_IN_ATTEMPTS`        | `1` in package scripts     | fail-fast main gate; opt into extra transient retries only for manual diagnosis       |
| `OUTSIDE_IN_TIMEOUT_MS`      | `80000` in package scripts | live-model attempt cap, leaving cleanup headroom under the 90-second suite contract   |
| `OUTSIDE_IN_TEST_TIMEOUT_MS` | `85000`                    | per-flow ceiling; `bail: 1` stops the matrix after the first failure                  |
| `OUTSIDE_IN_HOOK_TIMEOUT_MS` | `60000`                    | Vitest hook/global setup cap                                                          |

## Copilot auth

Live flows require a valid Copilot token; the tier prechecks and **fails fast**
with a clear message rather than hanging. Refresh + sync:

```bash
pnpm model:auth:refresh
```

Tokens are short-lived (~25 min); refresh before a live run.

## Relationship to Playwright e2e (G7)

Outcome coverage for the worker-exercising flows now lives here (headless,
fast). The Playwright suite is demoted to a thin **browser/rendering smoke**
layer: `pnpm test:e2e` skips the outcome-duplicating live-model specs, which
remain available via `pnpm test:e2e:full` (`E2E_FULL=1`).
