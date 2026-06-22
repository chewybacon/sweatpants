# AgentCore live e2e tests

These tests exercise real Amazon Bedrock AgentCore runtime-session behavior. They are intentionally **not** part of the default unit test suite because they are slower, require AWS credentials, require a deployed compatible tracer runtime, and can incur AgentCore runtime charges.

## Run

```sh
AWS_REGION=us-east-1 \
AGENTCORE_RUNTIME_ARN='arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/sweatpants_tool_session_tracer-e09bB9Edx5' \
AGENTCORE_ENDPOINT_NAME=DEFAULT \
AGENTCORE_LIVE_E2E=yes \
pnpm --filter @sweatpants/tool-runtime-agentcore test:e2e:agentcore
```

Optional:

```sh
AGENTCORE_INVOKER_LOG_LEVEL=warn
```

## Runtime contract required

The target runtime must speak the `sweatpants.agentcore.tool-session.v1` tracer protocol and expose these test tools:

- `simple_result`
- `elicit_then_result`
- `sample_then_result`

The runtime should also support the diagnostic test op:

- `runtime_diagnostics`

## What these tests verify

The suite verifies assumptions that are hard to prove with unit tests alone:

1. A raw completed tool session stays inspectable inside the runtime until `StopRuntimeSession` is called.
2. `StopRuntimeSession` removes or makes inaccessible the old in-memory runtime-session state.
3. The package adapter calls `StopRuntimeSession` after immediate terminal completion.
4. The package adapter does **not** stop while a tool is paused awaiting elicitation.
5. The package adapter calls `StopRuntimeSession` after a paused tool is resumed to terminal completion.
6. Runtime-session IDs isolate identical tool-session IDs.
7. Start-command duplicate/conflict semantics behave as expected.
8. Diagnostics expose process/cgroup memory and retained session counts.
9. Host sampling mode emits `sample_request` and waits for `respond_to_sample`.
10. Internal sampling mode can inherit or override the selected model, for example with `AGENTCORE_TOOL_SAMPLE_MODE=internal` and `AGENTCORE_TOOL_SAMPLE_MODEL_PROVIDER=amazon-bedrock` / `AGENTCORE_TOOL_SAMPLE_MODEL_ID=zai.glm-5`.

Every test attempts best-effort cleanup with `StopRuntimeSession` for every runtime session it creates.
