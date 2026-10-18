import { workerMain } from "@effectionx/worker";
import { createOperative, type Command, type Response } from "./executor-transport.ts";
import { createQuestionKernel } from "./question-kernel.ts";

await workerMain<Command, Response, void, undefined>(function* ({ messages }) {
  const operative = createOperative(createQuestionKernel());
  try {
    yield* messages.forEach(function* (command): import("effection").Operation<Response> {
      try {
        return yield* operative.exchange(command);
      } catch (error) {
        return {
          kind: "rejected",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
  } finally {
    yield* operative.close();
  }
});
