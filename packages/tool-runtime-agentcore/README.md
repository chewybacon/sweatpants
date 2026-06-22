# @sweatpants/tool-runtime-agentcore

AgentCore tool runtime adapter for Sweatpants chat.

This package provides:

- AgentCore-backed tool session registry and runtime client adapters
- AWS SDK invoker support for `InvokeAgentRuntime` and `StopRuntimeSession`
- local in-memory and Redis stores for serializable AgentCore tool-session handles/events
- framework `ToolRuntime` integration for remote MCP/plugin tools
- mocked unit-test runtime support
- opt-in live AgentCore e2e tests for runtime lifecycle and sampling assumptions

## Memory and lifecycle findings

See:

```txt
docs/memory-and-session-lifecycle.md
```

That document captures the live investigation findings around:

- measured Node/cgroup memory for AgentCore runtime sessions
- Cost Explorer GB-hour interpretation
- why terminal tool sessions previously continued billing
- explicit `StopRuntimeSession` behavior
- paused vs terminal lifecycle semantics
- per-run cost estimates for `book_flight`
- live e2e validation coverage

Key conclusion:

```txt
Actual measured host memory is small (~60–80 MiB cgroup, ~100–120 MiB RSS).
The main cost lever is AgentCore runtime-session duration.
Terminal tool sessions must explicitly call StopRuntimeSession.
```

## Tests

### Unit tests

Mocked/in-process tests:

```sh
pnpm --filter @sweatpants/tool-runtime-agentcore test
```

These do not hit AWS.

### Typecheck

```sh
pnpm --filter @sweatpants/tool-runtime-agentcore check
```

The package check builds framework declarations first because package-export type resolution depends on generated framework declaration files.

### Live AgentCore e2e tests

Opt-in live AWS tests:

```sh
AWS_REGION=us-east-1 \
AGENTCORE_RUNTIME_ARN='arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/sweatpants_tool_session_tracer-e09bB9Edx5' \
AGENTCORE_ENDPOINT_NAME=DEFAULT \
AGENTCORE_LIVE_E2E=yes \
AGENTCORE_INVOKER_LOG_LEVEL=warn \
pnpm --filter @sweatpants/tool-runtime-agentcore test:e2e:agentcore
```

See:

```txt
e2e/README.md
```

These tests are intentionally not run by default because they require AWS credentials, a compatible deployed tracer runtime, and can incur AgentCore runtime costs.

## AgentCore tool sampling modes

AgentCore-hosted tools default to host-mediated sampling:

```sh
AGENTCORE_TOOL_SAMPLE_MODE=host
```

In host mode, a tool `ctx.sample()` emits `sample_request` and the Sweatpants host responds with `respond_to_sample` using the selected chat model.

Internal runtime sampling is opt-in:

```sh
AGENTCORE_TOOL_SAMPLE_MODE=internal
AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER=amazon-bedrock
AGENTCORE_TOOL_SAMPLE_MODEL_ID=zai.glm-5
```

When `AGENTCORE_TOOL_SAMPLE_MODE=internal` and no explicit sample model is set, the runtime inherits `start_tool_session.context.model`. Inheriting local-only models such as `ollama/qwen3:30b` fails clearly; use host mode or configure an explicit AgentCore-reachable sample model such as `amazon-bedrock/zai.glm-5`.

## Runtime-session lifecycle contract

Terminal states:

```txt
completed
failed
cancelled
orphaned
```

Terminal sessions are stopped explicitly:

```ts
runtimeClient.stopRuntimeSession(handle)
```

Paused states:

```txt
awaiting_elicit
awaiting_sample
```

Paused sessions are not stopped because they need to remain resumable.

The handle records best-effort stop state:

```ts
stopRequestedAt?: string
stoppedAt?: string
```

Cleanup failure does not hide terminal tool results.
