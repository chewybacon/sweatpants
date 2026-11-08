# Application scope during the framework rewrite

The framework rewrite does not require every former application and deployment
to remain operational. We remove integrations that would otherwise force us to
maintain obsolete execution contracts, then rebuild them on the settled public API.

Temporarily removed applications:

- `yo-agent`
- `yo-studio`
- `lambda-durable-program-runtime`
- `lambda-microvm-sandbox`
- `agentcore-durable-program-runtime`
- `agentcore-tool-session-tracer`

Their complete source is available at commit `186dc451` before removal. The old
yo-chat Cloudflare and AgentCore deployment wiring is available at `3c764ea5`.
These deployment targets remain desired; removing their current integrations is
not a decision to abandon them. Historical design documents may refer to these
applications and should be read in that context.

Framework runtime packages and their independent acceptance coverage remain.
Remaining applications are not a promise to preserve every integration throughout
the rewrite; further removals should follow explicit scope decisions.
