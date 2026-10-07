# yo-chat Worker CPU profiling

From the repository root:

```sh
pnpm profile:yo-chat      # three repetitions
pnpm profile:yo-chat 5    # five repetitions
```

To compare exact saved builds, set `YO_CHAT_CPU_PROFILE_BUNDLE` to a captured
`run-N/worker.js` path and run one repetition at a time, alternating before and
after (reverse their order in successive pairs). The fixture uses that bundle
with fresh storage and the same assertions. Metadata records its path and SHA;
the working-tree revision then describes the harness, not the frozen worker.
This override exists only in the profiling test fixture, never in product apps.

Runs the existing card acceptance scenario through Test Rig with real local
workerd, D1, and Durable Objects. Test Rig controls model responses; no model
credentials, provider charges, product app overrides, or running dev server are
needed. The fixture bundles current workspace source with the development export
condition. Install workspace dependencies first.

Each repetition starts with a fresh temporary database. It sends “Pick a card”,
parks at the picker, destroys the Worker, restores the same database in a new
Worker, selects the first card, completes, and asks which card was picked.
Existing acceptance assertions verify restoration and recall. Card draws and
identifiers still vary; the operation sequence and model response structure are
fixed, not a byte-for-byte deterministic journal.

Artifacts go to `.artifacts/profiles/<timestamp>/`:

- `metadata.json`: scenario, revision, working tree status, tracked diff hash,
  Node version and sampling interval.
- `summary.json`: median/range and hottest self-time functions for each phase, aggregated
  across caller stacks.
- `run-N/initial.cpuprofile`: initial request through the parked picker.
- `run-N/restarted.cpuprofile`: restoration, selection, completion and recall.
- `run-N/worker.js`: the exact bundled source; profile `index.js` line numbers
  are zero-based and refer to this file.
- `run-N/test.log`: assertions and test diagnostics. A failed scenario stops the
  command and cannot contribute a successful benchmark result.

Open a `.cpuprofile` in Chrome DevTools or VS Code's JavaScript CPU profile viewer.
Use Bottom Up / self time to find expensive functions; inspect callers to find
which operation causes the work. The selected target is the yo-chat workerd
isolate, including its tool DO classes, not the Node/Vitest process or D1 engine.
Startup and schema initialization are outside the capture window. These phases
span multiple HTTP requests; do not compare them to one request's CPU budget.

Reported active time sums non-idle sample intervals (including GC), after ordering
samples by timestamp to handle V8 samples arriving out of order. Sampling adds overhead;
local hardware, JIT and GC affect results. Compare several runs on the same machine
and runtime version, without concurrent builds or CPU-heavy jobs. These are local
sample estimates, not Cloudflare's billed CPU measurements. Use production
`cpuTime`/`wallTime` and outcomes to confirm improvements after deployment.

For separate startup/import analysis, use `wrangler check startup` against the
built deployment config. For memory pressure, use workerd DevTools heap snapshots.
The CPU benchmark deliberately does not serialize every D1 result for metering:
that instrumentation would distort the CPU profile. D1 cost tests separately
assert row/query bounds and indexed query plans.

Cloudflare documentation:

- https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
