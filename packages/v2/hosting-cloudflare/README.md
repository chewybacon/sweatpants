# Cloudflare hosting

`createDurableObjectHost(options)` hosts one journal tree inside one Durable Object.
The journal uses the object's SQLite storage through `@sweatpan.ts/storage-sqlite`.

- `journal()` returns a fresh binding for commands: admit, answer, read.
- `wake()` prepares an in-memory frame buffer and sets an immediate alarm. Repeated
  wakes before dispatch share the pending buffer, preserving attached readers.
  A wake during advancement prepares a separate buffer for the next run.
- `alarm(info, install)` belongs in the object's `alarm(alarmInfo)` handler. Each
  call is a fresh execution; `install` adds middleware for that run only. The host
  is a scoped API with two interceptable methods: `advance` (defaults to the
  application's `advance(journal, emit)`) and `settle` (defaults to rethrowing a
  failure so Cloudflare retries the alarm). Each run consumes a pending buffer or
  opens a fresh one; retries never reuse a terminated buffer. Existing readers keep
  their original run's frames and completion or failure.
- `installAlarmRetryLimit(host, maxRetries, onExhausted)` stops retrying after
  `maxRetries` Cloudflare retries and ends the alarm normally.
- `events(offset, compact)` returns a lazy `ReadableStream` of provisional frames
  from the current activation, compacted to the reader's pace. It is `undefined`
  after eviction; the journal remains authoritative.

The application owns routing, authentication, program recovery, effect handling
and the wire format. Frames are not durable and are not replayed after eviction.

Acceptance: `hosting/durable-object-alarm.acceptance.test.ts` admits a program,
streams compacted deltas while the alarm drives it to a parked approval, restarts
workerd on persisted storage, answers, and lets the alarm complete it with no reader
attached and no redelivery, under both runtimes. A second journey traces each run
through `settle` middleware and shows the retry limit ending a failing alarm after
one Cloudflare retry.

Frame lifecycle regressions are also exercised under both runtimes in workerd with
explicit alarm dispatch and a simulated scheduler: recovery emits into a fresh
buffer, and duplicate wakes preserve readers attached before dispatch.
