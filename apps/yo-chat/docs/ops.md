# yo-chat operations

## Local host

Run `pnpm --filter yo-chat dev` from the repository root, then open
http://localhost:8000. Tools run in local workers; the host owns model inference,
journal acceptance and SQLite persistence.

| Setting | Purpose |
| --- | --- |
| `DEFAULT_CHAT_MODEL_PROVIDER` | Provider in the installed Pi model catalog |
| `DEFAULT_CHAT_MODEL_ID` | Model id for that provider |
| `ALLOWED_CHAT_MODELS_JSON` | Optional array of allowed `{ provider, id }` selections |
| `UNSAFE_ALLOW_ANY_CHAT_MODEL=yes` | Development override for the allow-list |
| `MCP_TOOL_RUNTIME` | Only `local` is supported |
| `AWS_REGION` | Region when using a Bedrock model |

Manage credentials with
`pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login`. Credentials in
`.sweatpants/auth.json` and environment variables must remain private.

The app resolves storage through `chatStorageFromEnv` and requires a persistent
SQLite path. The default authority file is
`apps/yo-chat/.data/yo-chat.sqlite.primitive-v2`, with metadata in its `.metadata`
sidecar. Back up both files consistently while the app is stopped. Old
ProgramDriver databases are not migrated into this journal format. Memory and
Postgres authority configurations are rejected by this app entry.

## Build and start

```sh
pnpm --filter yo-chat build
pnpm --filter yo-chat server
```

Provide the same model configuration and persistent storage as in development.
The old AgentCore and Cloudflare chat/tool deployments and their launch commands
are retired. The framework's remote runtime packages remain independent. No
ProgramDriver capability secret or Redis session configuration is required by
this local journal host. Its ProgramDriver inspector endpoint is unavailable.

## Verification

```sh
pnpm --filter yo-chat check
pnpm --filter @sweatpants/acceptance test yo-chat
pnpm --filter yo-chat test:acceptance
pnpm land
```

Central journeys cover in-process and worker placement with the same public tool
definitions. App acceptance covers terminal publication through both in-process
and HTTP clients. Provider-backed manual journeys require model credentials.
