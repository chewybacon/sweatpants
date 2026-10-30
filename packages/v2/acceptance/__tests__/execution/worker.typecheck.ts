import type { Runtime } from "@sweatpan.ts/runtime";
import type { Operation } from "@standard-durability/core";
import type { GuestWork, ProgramInvocation, ResolvedProgram } from "@sweatpan.ts/execution";
import {
  createWorkerExecution,
  serveGuestWorker,
  type GuestWorkerOptions,
  type WorkerGuestOptions,
} from "@sweatpan.ts/execution-worker";

/** Startup accepts data while server assembly supplies one acquisition mode. */
export function workerBootstrapTypes<Y>(
  runtime: Runtime<Y>,
  endpoint: WorkerGuestOptions,
  acquire: GuestWork<number, string, Y>,
  resolve: (invocation: ProgramInvocation) => Operation<ResolvedProgram<number, string, Y>, Y>,
) {
  const worker = createWorkerExecution<number, string, Y>(runtime, {
    invocation: { program: "pinned", input: { topic: "research" } },
    *open() {
      return endpoint;
    },
  });
  serveGuestWorker(runtime, { ...endpoint, resolve });
  serveGuestWorker(runtime, { ...endpoint, acquire });
  // @ts-expect-error A server is either prebound or initialized through its own resolver.
  const mixed: GuestWorkerOptions<number, string, Y, unknown, unknown> = {
    ...endpoint,
    acquire,
    resolve,
  };
  return { worker, mixed };
}
