# AgentCore memory, billing, and runtime-session lifecycle findings

This document captures the findings from the live AgentCore runtime investigation for `@sweatpants/tool-runtime-agentcore`.

The short version:

- The deployed AgentCore host process uses only about **60–80 MiB cgroup memory** and **100–120 MiB Node RSS** in the measured tracer runtime.
- Cost Explorer's `Runtime:Consumption-based:Memory` GB-hours are almost certainly based on **AgentCore billable runtime allocation × runtime-session duration**, not the Node process's actual heap/RSS.
- A terminal tool session does **not** automatically stop the AgentCore runtime session/container.
- `@sweatpants/tool-runtime-agentcore` now explicitly calls `StopRuntimeSession` after terminal tool sessions.
- Paused sessions, such as `awaiting_elicit` or `awaiting_sample`, intentionally remain alive so they can be resumed.

## Measurement context

Measurements were taken against the live tracer runtime:

```txt
arn:aws:bedrock-agentcore:us-east-1:988857891049:runtime/sweatpants_tool_session_tracer-e09bB9Edx5
```

The measurement image included a diagnostic protocol operation:

```txt
runtime_diagnostics
```

The diagnostic response includes:

- `process.memoryUsage()`
- `process.resourceUsage()`
- cgroup memory files:
    - `/sys/fs/cgroup/memory.current`
    - `/sys/fs/cgroup/memory.peak`
    - `/sys/fs/cgroup/memory.max`
    - `/sys/fs/cgroup/memory.stat`
- retained tool-session counts by status

The diagnostic operation lives in the tracer app protocol, not the generic package protocol:

```txt
apps/agentcore-tool-session-tracer/src/protocol.ts
apps/agentcore-tool-session-tracer/src/runtime-session-registry.ts
```

## Measured runtime memory

### Completed-session experiment

A fresh runtime session, before any tool session:

```txt
Node RSS:        112.8 MiB
Heap used:       26.9 MiB
Heap total:      56.6 MiB
cgroup current:  71.8 MiB
cgroup peak:     72.0 MiB
sessions:        0
```

After `simple_result` completed:

```txt
Node RSS:        113.2 MiB
Heap used:       27.7 MiB
Heap total:      57.1 MiB
cgroup current:  72.3 MiB
cgroup peak:     72.3 MiB
sessions:        1 terminal completed
```

After waiting 10 seconds:

```txt
Node RSS:        102.9 MiB
Heap used:       26.5 MiB
Heap total:      30.3 MiB
cgroup current:  59.9 MiB
cgroup peak:     74.7 MiB
sessions:        1 terminal completed
```

### Paused/idle-session experiment

A fresh runtime session, before any tool session:

```txt
Node RSS:        115.9 MiB
Heap used:       26.7 MiB
Heap total:      57.1 MiB
cgroup current:  75.1 MiB
cgroup peak:     75.2 MiB
sessions:        0
```

After starting `elicit_then_result` and leaving it awaiting user input:

```txt
Node RSS:        116.3 MiB
Heap used:       27.3 MiB
Heap total:      57.4 MiB
cgroup current:  75.4 MiB
cgroup peak:     75.4 MiB
sessions:        1 non-terminal awaiting_elicit
```

After 30 seconds idle:

```txt
Node RSS:        106.0 MiB
Heap used:       26.7 MiB
Heap total:      29.6 MiB
cgroup current:  62.4 MiB
cgroup peak:     77.3 MiB
sessions:        1 non-terminal awaiting_elicit
```

### Interpretation

The actual process/container memory is small:

```txt
~60–80 MiB cgroup current/peak
~100–120 MiB Node RSS
```

A retained tool-session record adds very little visible memory. The baseline Node/runtime process dominates.

Therefore, the AgentCore memory GB-hour spend was not caused by a Node heap leak or large retained tool state. It was caused by runtime sessions staying alive while AgentCore bills a managed runtime memory allocation over time.

## Cost Explorer findings

Month-to-date Cost Explorer query period:

```txt
2026-06-01 through 2026-06-23 end-exclusive
Metric: UnblendedCost
```

Relevant service summary:

| Service                          |   MTD cost |
| -------------------------------- | ---------: |
| Amazon Bedrock AgentCore         | $65.382935 |
| Amazon Bedrock                   |  $0.181787 |
| Total relevant Bedrock/AgentCore | $65.564723 |

AgentCore usage-type summary:

| Usage type                              |       Cost |                Usage |
| --------------------------------------- | ---------: | -------------------: |
| `USE1-Runtime:Consumption-based:Memory` | $62.623915 | 6626.869355 GB-hours |
| `USE1-Runtime:Consumption-based:vCPU`   |  $2.754529 | 30.776859 vCPU-hours |
| Other AgentCore usage                   | negligible |                  n/a |

Observed derived rates:

```txt
Runtime memory: ~$0.00945 per GB-hour
Runtime vCPU:   ~$0.08950 per vCPU-hour
```

In the observed bill, vCPU added roughly **4.4%** on top of memory spend. Memory GB-hours were about **95.8%** of AgentCore cost.

## AgentCore billable memory vs actual process memory

`GetAgentRuntime` did not expose an explicit memory or CPU sizing field for the deployed runtime.

Observed runtime config shape included lifecycle, network, artifact, protocol, metadata, and role information, for example:

```json
{
    "lifecycleConfiguration": {
        "idleRuntimeSessionTimeout": 900,
        "maxLifetime": 28800
    },
    "agentRuntimeArtifact": {
        "containerConfiguration": {
            "containerUri": "..."
        }
    }
}
```

It did **not** show a field such as:

```txt
memorySize
cpu
containerSize
ephemeralStorage
```

The working assumption is:

```txt
AgentCore memory charge = hidden/managed billable memory allocation × runtime-session duration
```

not:

```txt
actual Node RSS or heap usage × duration
```

## Runtime-session lifecycle findings

### What happens when a tool completes?

Before the stop-on-terminal fix, a completed tool session behaved like this:

```txt
tool coroutine completes
result event is emitted
tool session status becomes completed
terminal event stream closes
terminal session remains in the runtime process registry
AgentCore runtime session remains alive
billing continues until idle timeout/max lifetime/explicit stop
```

A raw completed session stayed inspectable after completion:

```json
{
    "type": "session_status",
    "status": "completed",
    "lastRuntimeEventSeq": 2
}
```

Ten seconds later, the same completed session was still inspectable.

### What happens when a tool is paused?

A paused tool session, such as one awaiting elicitation, remains non-terminal and resumable:

```json
{
    "status": "awaiting_elicit",
    "pendingRequest": {
        "type": "elicit",
        "elicitId": "..."
    }
}
```

Diagnostics showed:

```json
{
    "sessions": {
        "total": 1,
        "terminal": 0,
        "nonTerminal": 1,
        "byStatus": {
            "awaiting_elicit": 1
        }
    }
}
```

Paused sessions should not be stopped immediately, because stopping the runtime would destroy the state required to resume the tool.

## Stop-on-terminal behavior in this package

`@sweatpants/tool-runtime-agentcore` now explicitly stops the AgentCore runtime session after terminal tool states.

Terminal states:

```txt
completed
failed
cancelled
orphaned
```

Non-terminal states that remain alive:

```txt
initializing
running
awaiting_elicit
awaiting_sample
```

The package calls:

```ts
runtimeClient.stopRuntimeSession(handle);
```

from terminal ingestion paths in:

```txt
src/agentcore-session-registry.ts
src/agentcore-tool-session.ts
```

The terminal handle is annotated with:

```ts
stopRequestedAt;
stoppedAt;
```

Stop failure is best-effort:

- terminal tool result/error is already persisted locally
- cleanup failure does not hide the final tool outcome
- `stopRequestedAt` remains set if the stop call fails
- `stoppedAt` is set only on successful stop

## Live e2e validation

Live e2e tests live in:

```txt
packages/tool-runtime-agentcore/e2e/live-agentcore-lifecycle.test.ts
packages/tool-runtime-agentcore/e2e/README.md
```

They are opt-in and do not run in the default unit test suite.

Run them with:

```sh
AWS_REGION=us-east-1 \
AGENTCORE_RUNTIME_ARN='arn:aws:bedrock-agentcore:us-east-1:988857891049:runtime/sweatpants_tool_session_tracer-e09bB9Edx5' \
AGENTCORE_ENDPOINT_NAME=DEFAULT \
AGENTCORE_LIVE_E2E=yes \
AGENTCORE_INVOKER_LOG_LEVEL=warn \
pnpm --filter @sweatpants/tool-runtime-agentcore test:e2e:agentcore
```

The live suite verifies:

1. Diagnostics expose process/cgroup memory and session counts.
2. Raw completed tool sessions remain inspectable until `StopRuntimeSession` is called.
3. The package adapter stops runtime sessions after immediate terminal completion.
4. The package adapter does not stop paused `awaiting_elicit` sessions.
5. The package adapter stops runtime sessions after a paused session resumes to terminal completion.
6. Runtime-session IDs isolate identical tool-session IDs.
7. Start-command duplicate/conflict semantics behave as expected.

Latest observed result:

```txt
6 live e2e tests passed
```

## Cost estimate for a successful book-flight e2e run

Observed price from Cost Explorer:

```txt
$0.00945 per GB-hour
= $0.0001575 per GB-minute
```

Approximate formula:

```txt
memory_cost = billable_memory_GB × runtime_session_minutes × $0.0001575
approx_total = memory_cost × 1.044  # adds observed vCPU ratio
```

The actual billable memory allocation is not exposed by `GetAgentRuntime`, so estimates must use assumed billable memory sizes.

A successful full `book_flight` e2e smoke took about **1.7 minutes wall-clock**. The AgentCore runtime session may be active for less than that, but 1.7 minutes is a conservative upper bound.

Estimated cost after stop-on-terminal:

| Assumed billable memory | Memory cost | Approx total incl. vCPU |
| ----------------------: | ----------: | ----------------------: |
|                    8 GB |   ~$0.00214 |               ~$0.00224 |
|                   16 GB |   ~$0.00428 |               ~$0.00447 |
|                   32 GB |   ~$0.00857 |               ~$0.00894 |

Before stop-on-terminal, a completed tool session could remain alive until idle timeout. With a 15-minute idle tail, the same run could cost roughly:

| Assumed billable memory | Memory cost | Approx total incl. vCPU |
| ----------------------: | ----------: | ----------------------: |
|                    8 GB |   ~$0.01890 |               ~$0.01973 |
|                   16 GB |   ~$0.03780 |               ~$0.03946 |
|                   32 GB |   ~$0.07560 |               ~$0.07893 |

The biggest win is therefore not lowering Node memory; it is stopping terminal AgentCore runtime sessions immediately.

## Operational guidance

### Rely on explicit stop for terminal sessions

Terminal sessions should not wait for idle timeout. The package now stops them explicitly.

### Keep idle timeout as a safety net

Idle timeout still matters for abandoned sessions:

- user walks away while a tool is awaiting elicitation
- browser/test crashes mid-flow
- server process dies before cleanup
- network failure prevents terminal cleanup

But for normal successful tools, idle timeout should no longer dominate cost.

### Do not stop paused sessions prematurely

A tool in `awaiting_elicit` or `awaiting_sample` needs the AgentCore runtime session to remain available for resume.

If abandoned paused sessions become a cost problem, add an explicit pending-session TTL policy that marks them `orphaned` or `cancelled` before stopping the runtime session.

### Memory optimization is secondary

The runtime image should still stay lean, but measured process memory is already small. Code-level memory trimming is not expected to materially reduce AgentCore GB-hour costs unless AgentCore introduces or exposes adaptive billable memory sizing.
