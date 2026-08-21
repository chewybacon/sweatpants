# yo-chat Playwright suites

Yo-chat intentionally has two separate browser gates.

## Optional deterministic browser smoke

```bash
pnpm -C apps/yo-chat test:e2e
```

This runs thin browser-boundary tests when explicitly invoked. It is not part of
`pnpm land`; semantic chat behavior is covered by Test Rig and React/jsdom acceptance.

The optional presentation suite covers:

- canonical plugin DOM interaction;
- journal inspector UI;
- Markdown/KaTeX/Mermaid rendering and persistence.

Keep this suite provider-independent when possible. It must not become the source of
truth for message ordering, elicitation state, replay, or durable tool behavior.

## Extensive live-provider suite

Authenticate once, then run the full suite against the selected provider:

```bash
pnpm model:auth:login --provider openai-codex
pnpm test:yo-chat:e2e

# One-off provider/model override without changing the saved selection
pnpm test:yo-chat:e2e -- --provider opencode --model gpt-5.5
```

For interactive debugging:

```bash
pnpm test:e2e:manual:ui
```

The manual suite restores the broad historical browser coverage, including:

- threaded chat with one and multiple durable `pick_card` turns,
- replay of Mermaid/rendered content after refresh,
- `play_ttt` and standard `tictactoe` interaction, strategy, accumulation, and cancellation,
- complete `book_flight` flight/seat/confirmation flows,
- durable chat streaming, abort, reset, protocol, and reconnect behavior,
- pick-card and multi-turn tool calling,
- Markdown and math/rendering pipeline persistence.

It is intentionally **not** part of `pnpm land`: it is live-provider-dependent,
serial, and relatively slow. It has one provider-neutral contract and fails on
an unmet assertion; use the deterministic package acceptance suites for merge
gating and this suite for periodic browser/product confidence.
