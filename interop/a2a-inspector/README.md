# A2A Inspector interoperability pin

The independent interoperability target is the upstream A2A Inspector at commit
`8098818f97c6b8554f1f83636508a9608842f5a0`. `inspector.pin.json` also pins the
upstream Python SDK and reviewed lock-file digests. Floating `latest` images are
not certification inputs.

The standard-host conformance suite includes the Inspector SDK 0.3 compatibility
surface (`url`, `preferredTransport`, `/v1/message:stream`, protobuf-JSON
`content`, and `StreamResponse`) while retaining the current A2A 1.0 interface
projection.

## Certification scope

The pinned Inspector can certify browser-driven card discovery, custom/bearer
headers, text invocation, streamed Task/Message display, raw exchange display,
safe task failure, and context continuity over a second message. It does **not**
certify explicit `referenceTaskIds`, task-directed continuation, cancellation,
custom extension activation, delegated effects, exact private manifests, or
process replacement. Those remain first-party harness/conformance coverage.

Python, `uv`, Node dependencies for the Inspector, and Chromium are development
or CI dependencies only. They are not dependencies of any Sweatpants runtime
package.
