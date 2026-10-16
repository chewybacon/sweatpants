## Workspace member ledger

This tracked file is the single annotation source for the consumer-or-parked
workspace hygiene gate (`pnpm check:hygiene`). The no-sediment standing rules
live in the repository's `AGENTS.md` (see "The No-Sediment Rules
(pre-release)").

Every member with zero source-level consumers (per the spec's consumer
definition — test files and manifest declarations do not count) MUST carry a
status here. Statuses:

- `library` — has source-level consumers; listed for completeness.
- `product` — deployable endpoint; its consumers are deployments/users, not
  imports.
- `docs` — presentation artifact; its non-code purpose is stated in the note.
- `parked` — retained for a named future thread; the note carries the
  re-audit condition.
- `infrastructure` — test/tooling substrate consumed only by contexts the
  gate excludes (tests, acceptance suites).

| Member | Status | Note |
|---|---|---|
| `apps/agentcore-durable-program-runtime` | product | AgentCore-hosted durable program runtime deployment |
| `apps/agentcore-tool-session-tracer` | product | AgentCore tool-session tracer deployment |
| `apps/lambda-durable-program-runtime` | product | Lambda-hosted durable program runtime deployment |
| `apps/lambda-microvm-sandbox` | parked | Deployment shell of the parked lambda placement experiment (`packages/workspace-lambda-microvm`); re-audit: when the experiment resumes, the thread either gains a real production consumer or is deleted |
| `apps/storage-inspector` | product | SQLite storage inspection UI (development tool) |
| `apps/yo-agent` | product | Agent product endpoint |
| `apps/yo-chat` | product | Primary chat product endpoint |
| `apps/yo-mcp` | product | MCP server product endpoint |
| `apps/yo-slides` | docs | Presentation artifact — slide decks for audiences, not product code |
| `apps/yo-studio` | product | Studio product endpoint; its `vite.config.ts` AWS-placement branch is part of the parked lambda experiment thread |
| `apps/yo-workflow` | parked | Timeboxed Tisyn-to-durable-tool binding spike; re-audit: promote the binding after park/replay evidence or delete the app |
| `packages/agent-host` | library | |
| `packages/agent-sdk` | library | |
| `packages/chat-client` | library | |
| `packages/chat-contract` | library | |
| `packages/chat-core` | library | |
| `packages/cloudflare-tasks` | library | Wrangler binding tasks used by yo-chat storage preparation |
| `packages/cli` | product | Developer CLI entry point |
| `packages/durable-chat-runtime` | library | |
| `packages/durable-effects` | library | |
| `packages/durable-execution` | library | |
| `packages/durable-storage-kernel` | library | |
| `packages/durable-streams` | library | |
| `packages/foundation` | library | |
| `packages/frame-renderer` | library | Demand-driven frames and renderer authoring |
| `packages/history-store` | library | |
| `packages/journal-authority` | library | |
| `packages/model-provider` | library | |
| `packages/model-provider-pi-ai` | library | |
| `packages/model-sampling` | library | |
| `packages/platform-acceptance` | infrastructure | Acceptance suite — the landing gate |
| `packages/react-chat` | library | |
| `packages/durable-streams-cloudflare` | library | Durable Object response buffers and registry storage for yo-chat |
| `packages/storage-d1` | library | D1 durable kernel for the conversation and execution repositories |
| `packages/scheme-runtime` | library | Hoot evaluator and pinned WASM build consumed by yo-workflow |
| `packages/storage-sqlite` | library | |
| `packages/stream-bridge` | library | |
| `packages/test-rig` | infrastructure | Test substrate consumed only by acceptance/yo-chat test contexts |
| `packages/tool-runtime` | library | |
| `packages/tool-runtime-agentcore` | library | |
| `packages/tool-runtime-cloudflare` | library | Cloudflare Dynamic Workers for durable programs and Durable Objects for ordinary tool sessions |
| `packages/tool-runtime-local` | library | |
| `packages/tool-session` | library | |
| `packages/ts-config` | infrastructure | Shared tsconfig base; consumed via manifest/tsconfig extends only |
| `packages/vite-plugin` | library | |
| `packages/workspace-lambda-microvm` | parked | Lambda placement experiment (consumed by yo-studio's AWS-placement branch); re-audit: when the experiment resumes, it either gains a real production consumer or is deleted |
| `packages/workspace-runtime` | library | |
| `packages/workflow-kernel` | parked | Kernel contract review scaffold; re-audit after Hoot fresh-instance continuation proof |
| `packages/program-backend-kernel` | parked | Kernel backend for the shared program driver; experimental Hoot and reference evaluator consumers |
