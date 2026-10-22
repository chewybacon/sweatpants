# Host crash acceptance

This folder owns abrupt loss of the application host process. Tests start
a real Node child process, kill it with `SIGKILL`, and start a fresh process over
the same temporary SQLite database. The client and model simulator remain owned
by the parent test process.

Layout:

```text
host-crash/
  durable-recovery.acceptance.test.tsx
  fixtures/
    host.ts          # HTTP application running in the child process
    # host imports the shared authored durable-selection fixture
```

The scenario:

1. Completes a recorded effect and observes a persisted pending elicitation.
2. Kills the host without calling application cleanup, and awaits process exit.
3. Starts a fresh host against the same database.
4. Reconnects a fresh public client and answers the restored elicitation.
5. Asserts retained history, no re-execution of the recorded effect, and one
   final tool result.

Observe effect executions across both process generations; inspecting only the
recovered journal would not prove the effect body was not run again. Temporary
storage survives the crash and is removed after the scenario. Teardown must
reclaim every child process, including when an assertion fails.

Graceful host replacement belongs in `../recovery/`. Worker loss belongs in
`../tool-runtimes/local-worker/`. This folder tests application process loss;
disk loss and machine power failure are separate failure boundaries.

The scenario runs under the single `pnpm test:acceptance` command. Process
lifecycle and HTTP forwarding live in `../../support/host-process.ts`.
