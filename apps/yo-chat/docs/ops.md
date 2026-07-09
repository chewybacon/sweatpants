# yo-chat Ops

Production-candidate ops story for the cutover app (`apps/yo-chat`).

## Required environment variables

| Variable | Required | Description |
|---|---|---|
| `DEFAULT_CHAT_MODEL_PROVIDER` | Yes (for real chat) | e.g. `ollama`, `github-copilot`, `amazon-bedrock`, `openai` |
| `DEFAULT_CHAT_MODEL_ID` | Yes (for real chat) | Model id for the chosen provider |
| `COPILOT_GITHUB_TOKEN` / Sweatpants auth file | When using GitHub Copilot | Prefer `pnpm copilot:auth:login` — do not commit tokens |
| `MCP_TOOL_RUNTIME` | No | `local` (default) or `agentcore` |
| `REDIS_URL` | No | When set, durable token buffers use Redis |
| `AGENTCORE_RUNTIME_ARN` | AgentCore only | Remote tool runtime ARN |
| `AWS_REGION` / `AGENTCORE_REGION` | AgentCore / Bedrock | AWS region |
| `VITE_ENABLE_SCRIPTED_RENDERING` | No | Test/scripted rendering flag |

**Secrets:** never hardcode API keys or tokens in source or docs. Use env vars or `pnpm copilot:auth:*` helpers. Durable stores and model credentials are sensitive configuration and must not be committed.

## Session / token buffer store

| Mode | When | Behavior |
|---|---|---|
| **In-memory** (default) | No Redis client configured | Shared in-process durable streams; fine for local demo and single-node |
| **Redis** | `REDIS_URL` (or shared Redis client) available | Token buffer store backed by Redis via `@sweatpants/durable-streams/redis` |

Fold-session buffer store is currently in-memory (`createSessionContractInMemoryStore`) even when Redis backs the token buffer.

## Model provider configuration

Primary chat inference is configured with `DEFAULT_CHAT_MODEL_PROVIDER` + `DEFAULT_CHAT_MODEL_ID` and wired through `@sweatpants/model-provider-pi-ai` (canonical app-wiring, not happy-path shopping).

Examples:

```bash
# Local Ollama
DEFAULT_CHAT_MODEL_PROVIDER=ollama DEFAULT_CHAT_MODEL_ID=gemma4:12b-mlx

# GitHub Copilot (after pnpm copilot:auth:login)
DEFAULT_CHAT_MODEL_PROVIDER=github-copilot DEFAULT_CHAT_MODEL_ID=claude-sonnet-4.5

# Amazon Bedrock
DEFAULT_CHAT_MODEL_PROVIDER=amazon-bedrock DEFAULT_CHAT_MODEL_ID=zai.glm-5 AWS_REGION=us-east-1
```

## Run locally

From monorepo root:

```bash
pnpm install

# Recommended local defaults (local tools, no AgentCore)
pnpm dev:yo-chat:local

# Or default root script (Copilot-oriented defaults)
pnpm dev:yo-chat
```

App: `http://localhost:8000`  
Durability Lab: `http://localhost:8000/lab/durability`

## Deploy / start

1. Build:

```bash
pnpm -C apps/yo-chat build
```

2. Start the Node server entry:

```bash
pnpm -C apps/yo-chat server
# or: node apps/yo-chat/dist/express-server.js
```

3. Provide the same env vars as local for model provider and optional Redis/AgentCore.

4. For AgentCore tool runtime (optional paid path), see `apps/yo-chat/README.md` — requires `MCP_TOOL_RUNTIME=agentcore` and a valid `AGENTCORE_RUNTIME_ARN`.

## MCP tool runtime modes

| Mode | Env | Notes |
|---|---|---|
| Local (default) | `MCP_TOOL_RUNTIME=local` | Tool generators run in local worker/session runtime |
| AgentCore | `MCP_TOOL_RUNTIME=agentcore` | Remote tool execution; chat/elicit UI remain local |

## Security notes

- Do not expose production credentials in client-side samples
- Redis and model credentials are server-side only
- Copilot tokens live in env or `~/.sweatpants/auth.json` (gitignored patterns)
