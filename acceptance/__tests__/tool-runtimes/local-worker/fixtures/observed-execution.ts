import { resolve } from "node:path";
import { local } from "@sweatpants/tool-runtime-local";
import type { ToolExecutionAdapter } from "@sweatpants/tool-session/execution";

/** Observe the real public driver boundary; no execution or replay is simulated. */
export function observedExecution(fenced = false) {
  const stats = { activeAttachments: 0, attachmentCount: 0, shutdownCount: 0 };
  const placement = local({
    durableWorker: resolve("__tests__/tool-runtimes/local-worker/fixtures/durable-worker.mjs"),
  });
  const execution: ToolExecutionAdapter = {
    prepare(tools, routeId) {
      const prepared = placement.prepare(tools, routeId);
      return {
        ...prepared,
        bindings: prepared.bindings?.map((binding) =>
          fenced ? { ...binding, activation: "fenced" as const } : binding,
        ),
        drivers: prepared.drivers?.map(
          ([kind, driver]) =>
            [
              kind,
              {
                ...driver,
                *attach(request) {
                  const attachment = yield* driver.attach(request);
                  stats.attachmentCount += 1;
                  stats.activeAttachments += 1;
                  return attachment;
                },
                *shutdown(attachment, reason) {
                  try {
                    return yield* driver.shutdown(attachment, reason);
                  } finally {
                    stats.shutdownCount += 1;
                    stats.activeAttachments -= 1;
                  }
                },
              },
            ] as const,
        ),
      };
    },
  };
  return { execution, stats };
}
