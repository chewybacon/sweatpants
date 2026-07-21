/**
 * Worker entry for the acceptance fixture tool.
 *
 * Mirrors the framework-generated tool worker: it imports the SAME authored
 * tool and invokes its real execute generator through the contract protocol.
 * There is exactly one implementation of acceptance_booking.
 */
import { runWorker, createWorkerToolRegistry } from "@sweatpants/tool-runtime-local/worker";
import { acceptanceBookingTool } from "./acceptance-booking.tool.ts";

const registry = createWorkerToolRegistry([
  {
    name: acceptanceBookingTool.name,
    handler: function* (params, ctx) {
      // Invoke the authored contract exactly as the generated app worker does.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invoke = yield* (acceptanceBookingTool as any)(ctx);
      return yield* invoke(params);
    },
  },
]);

runWorker(registry).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
