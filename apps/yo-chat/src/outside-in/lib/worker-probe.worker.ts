/**
 * Worker-only probe entry for the worker-boundary test (design R8 / Q2).
 *
 * Runs inside a genuine worker thread. The `worker_probe` tool reports thread
 * identity (`isMainThread`, `threadId`, `pid`) that is only observable OFF the
 * main thread. A test asserts `isMainThread === false`, so an in-process
 * fallback masquerading as a worker cannot pass silently.
 *
 * Loaded by a worker thread spawned with `--import tsx`.
 */
import { runWorker, createWorkerToolRegistry } from "@sweatpants/tool-runtime-local/worker";
import { isMainThread, threadId } from "node:worker_threads";

const registry = createWorkerToolRegistry([
  {
    name: "worker_probe",
    handler: function* () {
      return {
        isMainThread,
        threadId,
        pid: process.pid,
      };
    },
  },
]);

runWorker(registry);
