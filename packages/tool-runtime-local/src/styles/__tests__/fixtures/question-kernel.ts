import { createExecution, type Json } from "@sweatpants/foundation";
import type { Kernel, Boundary } from "./executor-transport.ts";

/** Tiny deterministic kernel: program is a list of requests followed by its input and answers. */
export function createQuestionKernel(): Kernel {
  return {
    *start(program, input) {
      if (!Array.isArray(program)) {
        throw new Error("Expected a request list");
      }
      const requests: Json[] = program;
      const answers: Json[] = [];
      let index = 0;
      let cleaning = false;
      function next(): Boundary {
        return index < requests.length
          ? { kind: "suspended", suspensionId: String(index), request: requests[index]! }
          : { kind: "completed", value: { input, answers } };
      }
      return createExecution({
        initial: next(),
        driver: {
          *cancel() {
            cleaning = true;
            return { kind: "suspended", suspensionId: "cleanup", request: { release: input } };
          },
          *resume(_id, reply: Json) {
            if (cleaning) {
              return { kind: "cancelled" };
            }
            answers.push(reply);
            index++;
            return next();
          },
          *dispose() {},
        },
      });
    },
  };
}
