# Sequential journal acceptance fixture

`scenario.ts` creates fresh journal, driver, clock and SQLite resources for each
invocation. `launchLocal` runs it in the existing test process and closes storage
before returning. Validation, corruption, rollback, fencing, reference comparison
and persisted readback do not require another Node startup.

`worker.ts` is the same scenario with abrupt `process.exit` at interruption
boundaries. Four stories retain real child processes:

- Both accepted occurrences, cold recovery, and completed reconnect.
- External completion before acceptance, followed by cold recovery.
- Recovery permission committed before dispatch, followed by cold recovery.
- Repeated losses at both identical occurrences, with retained-capability probes.

Recovery rejection fixtures also reuse two immutable databases produced by real
process death. Reopen and close a crashed database before copying its main file:
committed transactions may still be in WAL. Each policy case gets its own copy.

Local accepted-boundary stops use a fixture exception **after** acceptance, outside
the engine's failure-cleanup block. They close SQLite and test resource reopening;
they do not claim process-death coverage. Unaccepted-result and permission-loss
interruptions always use real child processes, so cleanup cannot change the state
being tested. Cold recovery reloads the framework and does not reuse an iterator.

The suites write `launch-counts.json` beside their existing artifacts and enforce
ceilings of four sequence workers and twelve recovery workers. The existing
20-second child and 30-second case deadlines remain. Three sequential fragments
of the repeated-loss story are now part of one test, with their assertions intact.
