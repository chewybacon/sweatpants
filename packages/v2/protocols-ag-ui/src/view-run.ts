import type { Runtime } from "@sweatpan.ts/runtime";
import type { AgUiRun, AgUiViewRunOptions } from "./contracts.ts";
import { createAgUiRun } from "./run.ts";

/** Compose public snapshot publication and pending-question interrupts over the
 * low-level run adapter. Command, view and disclosure policy remain with the host.
 * Owns no additional producer or scope: cleanup, cancellation, independent readers
 * and retained-event lifetime follow createAgUiRun. Selection/cloning failures
 * publish the host's public error and propagate the original error to the owner. */
export function createAgUiViewRun<V, Y>(
  runtime: Runtime<Y>,
  options: AgUiViewRunOptions<V, Y>,
): AgUiRun<V, V, Y> {
  return createAgUiRun<V, V, Y>(runtime, {
    threadId: options.threadId,
    runId: options.runId,
    errorMessage: options.errorMessage,
    *execute(publish) {
      const view = yield* options.execute(publish.text);
      publish.endText();
      publish.custom(options.viewEvent, view);
      return view;
    },
    outcome(view) {
      const interrupts = Array.from(options.pendingQuestions?.(view) ?? [], (question) => ({
        id: question.id,
        reason: "input_required",
        metadata: { "sweatpants/question": question },
      }));
      return interrupts.length ? { type: "interrupt", interrupts } : undefined;
    },
  });
}
