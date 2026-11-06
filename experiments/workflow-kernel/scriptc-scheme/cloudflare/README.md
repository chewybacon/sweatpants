# Linked workflow on Cloudflare local

A local-only browser assembly of the v2 linked Scheme experiment. This is separate
from v1 yo-workflow and the Node yo-chat-v2 app.

The build compiles current developer TypeScript through live ScriptC into the
shared Scheme IR. A live model (Luna 6 by default) writes a small Scheme caller
and draft input. A Worker links that caller to the private compiled review workflow.
An Effection runtime hosts it using the existing v2 recovery/checkpoint middleware
and a Durable Object SQLite journal. Approval and cleanup are participant waits;
every answer restores a fresh Wasm machine. Reads do not run a model or Guest.

## Run from the repository root

Use installed Node 24.22.0 and workspace dependencies:

```sh
mise exec node@24.22.0 -- node --conditions=development --import tsx experiments/workflow-kernel/scriptc-scheme/cloudflare/prepare.mjs
mise exec node@24.22.0 -- apps/yo-workflow/node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8788 --config experiments/workflow-kernel/scriptc-scheme/cloudflare/wrangler.jsonc
```

Create an ignored `.dev.vars` beside `wrangler.jsonc`, with `OPENAI_BASE_URL`
(the configured CLI proxy URL ending in `/v1`), `OPENAI_API_KEY`, and
`CHAT_MODEL=gpt-6-luna`. Credentials are server-only. The Responses API request
has no automatic retry. No production deployment or account binding is needed.

Open http://127.0.0.1:8788. Generate a caller, inspect its approval wait, reload,
approve, inspect cleanup, then complete cleanup. Keep the `?run=` URL to revisit
that Durable Object. **New run** selects a fresh object rather than deleting data.

`prepare.mjs` checks the v2 Scheme asset manifest and emits a local Worker loader
that instantiates bundled Wasm modules. Its runtime identity includes that adapter.
It runs ScriptC at build time; no compiler subprocess runs inside workerd.
The package-generated Worker loader is reused with only its three Wasm import paths
relocated. Generated assets and local credentials are ignored. The installed yo-workflow
Wrangler binary is reused; no v1 execution implementation is imported.

## Observed live evidence, 2026-11-06

- Model: `gpt-6-luna`, through the configured live CLI proxy.
- Provider response: `resp_050bbbb853fad90b016aee0167389487d18fe49007da3b0c54`.
- Run: `9ee0774f-0f79-4063-a8ee-af4f6d3073de`.
- Model-authored caller invoked `review_draft`; draft:
  “Join us Friday for a rock-paper-scissors tournament!”
- Approval at `review.workflow.ts:9`: revision 2, starts 1, restores 0.
- Browser reload preserved the approval and provider response.
- Approved: cleanup at `review.workflow.ts:13`, revision 5, restores 1.
- Wrangler was terminated and restarted while cleanup was pending. Reload recovered
  that same cleanup wait from Durable Object SQLite.
- Completed: `caller:approved:yes`, revision 7, starts 1, restores 2.
- A browser recording captured generation, inspection, reload and completion.
  Local evidence lives in `.artifacts/linked-cloudflare/`.

## Scope

This demonstrates one approved workflow with a real provider, local workerd and
actual Durable Object SQL storage. The prior in-process acceptance journey covers
decline, cancellation and rejection cases; this browser recording does not establish
those paths on Cloudflare. No email is sent. The model is prompted to use the bounded
caller profile; admission and the evaluator still enforce the private-code boundary.

The JSON serializer supports this fixture's JSON-shaped journal values, not arbitrary
application data. Per-object command serialization prevents concurrent advancement.
Answer grants, current request text and terminal results now come directly from one
journal read. No separate saved UI receipt supplies action controls. The original
model input is labeled separately from the actual pending approval message.

If the first execution fails, or an answer commits before advancement finishes,
**Advance retained run** explicitly resumes the saved program through existing host
recovery. It makes no provider call and passes no attempt replacement authority.
Invalidated interactions remain invalidated. Reads never implicitly advance.
Run metadata and counters remain diagnostic side records; interruption can lose
counter increments, so counters alone are not recovery proof. Model generation itself is not a durable journaled effect: interruption before saving
the run can leave an unknown provider outcome. There is no automatic retry.

Inspection reads the journal's program-bound checkpoint. This demo has no
cancellation command or separate cancellation-diagnostic publication. Regenerating
the build cannot silently upgrade retained executions; advancement checks the
original program identity. Keep old build assets to advance old runs.

This is loopback-only exploratory UI, not a deployed multi-user service or a promoted
Cloudflare adapter. The full repository gate does not exercise live providers or
this manual local server journey.

## Review regression evidence

The Worker and the in-process acceptance journey use the same experiment-local
`execution.mts` assembly. The journey exercises an initial loader failure, SQLite
reopen without a UI receipt, actual-request versus original-input mismatch, an
accepted answer interrupted before advancement, and journal-derived completion.
The original recording above predates these review fixes and is not a recording
of the updated UI.

Caller admission reserves `root` and permits only safe integer numeric literals.
Fractions, decimal/exponent forms, negative zero and out-of-range integers reject
before the reader loses their spelling. Control-character/string escape behavior
is exercised against the real kernel. The evaluator remains the final authority
for expression validity and protected binding rules; linker admission is not a
complete static checker and does not require the caller to invoke the workflow.
