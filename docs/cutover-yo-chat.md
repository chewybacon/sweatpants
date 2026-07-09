# Cutover Report: yo-chat

## 1. Designated app

**App:** `apps/yo-chat`  
**Role:** Phase 5 production-candidate cutover target (default per product surface program)  
**Date:** 2026-07-09

## 2. Lane compliance

| Check | Status |
|---|---|
| Product + canonical imports only for runtime source | **Pass** — Phase 0 inventory found zero experimental-lane imports |
| Grandfather exceptions remaining | **None** |
| Validator | `pnpm validate:product-surface` covers `apps/yo-chat` |

Experimental paths (isomorphic tools public authoring, retired agent package) are not imported by yo-chat source.

## 3. Demos covered

| Demo | User path | Automated gate |
|---|---|---|
| Reconnect mid-stream | `/chat/basic` + Durability Lab | `demo-reconnect-mid-stream.acceptance.test.ts` |
| Elicit pause/resume | `/chat/flight` + Durability Lab | `demo-elicit-pause-resume.acceptance.test.ts` |
| MCP → browser elicit | `/chat/cards` + Durability Lab | `apps/yo-chat/acceptance/demo-mcp-browser-elicit.acceptance.test.ts` |

Lab entry: `/lab/durability` · Docs: `docs/demos/`

## 4. Real usage coverage (REQ-035)

| Behavior | Evidence |
|---|---|
| Multi-turn chat | `/chat/basic`, `/chat/threaded`, durable-chat e2e |
| Tool calls | math, flight, cards, tictactoe routes + acceptance |
| Elicit flow | flight / cards / pick-card e2e and acceptance |
| Reconnect / replay | durable-chat e2e + reconnect acceptance demo |

## 5. Residual substrate risks

- Session-contract fold/body modes and AG-UI strictness still evolve under the facade
- Redis-backed durable streams are optional; default local path is in-memory
- AgentCore tool runtime is optional advanced wiring; not required for happy path
- Live model providers introduce flake for e2e; protocol claims are locked by acceptance tests with mock providers
- Phase 3 (Effection hiding) and Phase 6 (interop) are explicitly out of scope and non-blocking

## 6. Ops documentation

See [apps/yo-chat/docs/ops.md](../apps/yo-chat/docs/ops.md) for:

- Required environment variables
- Session/token buffer store choice (in-memory vs Redis)
- Model provider configuration
- Local run
- Deploy / start notes

## 7. Quality gates

Recorded **2026-07-09** on the cutover path (canonical product facade + yo-chat).

| Gate | Result | Notes |
|---|---|---|
| Product surface validator | **Pass** | `pnpm validate:product-surface` (also hooked into root `pnpm build`) |
| Framework acceptance | **Pass** 7/7 | golden-path + reconnect demo + elicit pause/resume demo |
| yo-chat acceptance | **Pass** 4/4 | MCP browser-elicit demo + book-flight strict params |
| yo-chat e2e (durable/HITL slice) | **Pass** 18/18 | `durable-chat` + `pick-card` + `deterministic-elicit-rendering` (Playwright, fresh server, github-copilot) |
| yo-mcp e2e | **Pass** 10/10 | includes pick_card accept + decline elicit paths |
| Full monorepo `pnpm test:e2e` | Not re-run as entire matrix | Applicable durable/elicit/MCP gates above are green; full suite demotes some live-model specs unless `E2E_FULL=1` |

### E2e evidence mapped to REQ-035

| Behavior | Evidence |
|---|---|
| Multi-turn chat | durable-chat feature parity + tool calling |
| Tool calls | calculator + pick_card durable-chat e2e |
| Elicit flow | durable-chat pick_card interact; deterministic-elicit-rendering; yo-mcp pick_card |
| Reconnect / replay | durable-chat reconnection (conversation id across refresh + clear history) + reconnect acceptance |

## 8. Runs in anger

**Statement:** yo-chat is the production-candidate reference app fully on the product + canonical lanes. As of 2026-07-09 it has been exercised with automated acceptance and applicable e2e gates for multi-turn durable chat, tool calling, elicit HITL, and reconnect/replay, with zero experimental-lane runtime imports. Ops and demo paths are documented; the product facade is locked by allowlist + golden path + differentiator demos.

This cutover does **not** claim a public npm product launch or Phase 3/6 completion.
