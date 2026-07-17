# A2A Inspector interoperability pin

The independent interoperability target is the upstream A2A Inspector at commit
`8098818f97c6b8554f1f83636508a9608842f5a0`. `inspector.pin.json` also pins the
upstream Python SDK and reviewed lock-file digests. Floating `latest` images are
not certification inputs.

The reviewed compatibility patch under `patches/` adds one missing UI-backend
behavior: after an `input-required` or `auth-required` update, the next UI message
carries that interrupted `taskId`. The launcher applies this exact digest-pinned
patch after verifying the pristine upstream commit. No host-side ambient task
inference is used.

The required Playwright suite lives in `apps/yo-a2a/e2e`. It launches the
actual authored `yo-a2a` agent in deterministic model mode, then drives the
Inspector browser through guidance loading, durable tool execution,
`input-required`, same-task continuation, and a later conversational turn.
Normal `pnpm -C apps/yo-a2a dev` uses the configured real pi-ai model instead.

The standard-host conformance suite includes the Inspector SDK 0.3 compatibility
surface (`url`, `preferredTransport`, `/v1/message:stream`, protobuf-JSON
`content`, and `StreamResponse`) while retaining the current A2A 1.0 interface
projection.

## Certification scope

The patched pinned Inspector can certify browser-driven card discovery,
custom/bearer headers, text invocation, streamed Task/Message display, raw
exchange display, safe task failure, context continuity, and single interrupted
task-directed continuation. It does **not** certify explicit `referenceTaskIds`,
cancellation,
custom extension activation, delegated effects, exact private manifests, or
process replacement. Those remain first-party harness/conformance coverage.

Python, `uv`, Node dependencies for the Inspector, and Chromium are development
or CI dependencies only. They are not dependencies of any Sweatpants runtime
package.
