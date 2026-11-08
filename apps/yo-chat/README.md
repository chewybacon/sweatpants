# yo-chat

Reference chat app using the local SQLite journal host and worker placement.

## Run

From the repository root:

```sh
pnpm --filter yo-chat dev
pnpm --filter yo-chat check
pnpm --filter yo-chat build
```

The development server listens on http://localhost:8000. Configure model credentials
with `pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login` and select a
model with `DEFAULT_CHAT_MODEL_PROVIDER` and `DEFAULT_CHAT_MODEL_ID`.
See [operations](docs/ops.md) for storage and production startup.

## Tools

`src/server/tool-definitions.ts` contains the single inventory: calculator,
ask-question, book-flight, pick-card, play-ttt and tictactoe. Each tool is authored
once with the public SDK's fluent `createDurableTool` builder. UI plugins use
`makePlugin(tool)` with that same definition. Output schemas are optional; the
builder infers results from generator returns.

The host and `journal-tool-worker.ts` share this inventory. Placement acquires a
Guest; the journal advances it and records accepted outcomes. The host owns native
effect handlers in `src/server/tool-effects.ts`, model requests and SQLite storage.
Parking releases the worker; accepting an answer reconstructs the tool and replays
accepted outcomes. Tests can use the same definitions with in-process placement.

Card draw declares an unsafe retry policy: accepted cards replay unchanged. A
started draw without an accepted outcome stops recovery with `outcome_unknown`.

## Retired deployments

The old yo-chat AgentCore and Cloudflare chat/tool deployment wiring, legacy
program factories, compatibility tool definitions and deployment launchers have
been removed. `MCP_TOOL_RUNTIME` only accepts `local`. Framework runtime packages
and their independent acceptance coverage remain available. Standalone metadata
and task workers are separate from this retired chat deployment.

The journal host uses a separate `.primitive-v2` database; it does not reinterpret
old ProgramDriver history. The old ProgramDriver inspector is unavailable on this
host.

## Acceptance coverage

Central acceptance journeys exercise the same tools in-process and in workers,
including elicitation, nested sampling, completion, cancellation and replay:

```sh
pnpm --filter @sweatpants/acceptance test yo-chat
pnpm --filter yo-chat test:acceptance
pnpm land
```
