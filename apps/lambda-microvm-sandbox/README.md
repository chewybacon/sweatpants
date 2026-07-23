# Lambda MicroVM Durable Sandbox Spike

A minimal Node.js 24 agent sandbox on AWS Lambda MicroVMs. Images target ARM64 and are built for every currently available Lambda Graviton generation; runtime placement uses the latest service-selected compatible chipset.

The container exposes:

- application HTTP on port `8080`;
- lifecycle hooks on port `9000`;
- shell ingress on port `8022` when attached at `RunMicrovm`;
- a private writable workspace at `/workspace`.

Lambda snapshots and restores both memory and disk when the same MicroVM is suspended and resumed. The workspace does **not** survive termination or the hard eight-hour MicroVM lifetime; replacement durability requires an external checkpoint.

## Run

```bash
cd sweatpants
AWS_PROFILE=default \
  pnpm -C apps/lambda-microvm-sandbox sandbox:run -- agent-task-1
```

The local control record is written to:

```text
.sweatpants/lambda-microvm-sandbox.json
```

## Use the workspace API

```bash
pnpm -C apps/lambda-microvm-sandbox sandbox:request -- \
  POST /workspace/write '{"path":"memory.txt","content":"remember this"}'

pnpm -C apps/lambda-microvm-sandbox sandbox:request -- \
  GET '/workspace/read?path=memory.txt'
```

The request script mints a short-lived, port-scoped auth token for every call and does not persist it.

## Open a shell

```bash
pnpm -C apps/lambda-microvm-sandbox sandbox:shell
```

The shell token is short-lived and is passed only to the WebSocket client process.

## Lifecycle

```bash
pnpm -C apps/lambda-microvm-sandbox sandbox:state
pnpm -C apps/lambda-microvm-sandbox sandbox:suspend
pnpm -C apps/lambda-microvm-sandbox sandbox:resume
pnpm -C apps/lambda-microvm-sandbox sandbox:terminate
```

The default run configuration auto-suspends after five idle minutes, auto-resumes on ingress, and has the maximum eight-hour lifetime.

## Build the image artifact

```bash
pnpm -C apps/lambda-microvm-sandbox build:artifact
```

The zip has a `Dockerfile` at its root and is suitable for `CreateMicrovmImage` or `UpdateMicrovmImage`.
