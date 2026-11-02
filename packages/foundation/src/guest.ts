import type { Guest, Turn } from "./computation.ts";
import { createExecutionDiscipline } from "./execution-discipline.ts";

/** Apply the shared execution discipline to a cursor's native mechanics. */
export function createGuest<T, Request, Y, Value = unknown, Error = unknown>(
  driver: Guest<T, Request, Y, Value, Error>,
): Guest<T, Request, Y, Value, Error> {
  const discipline = createExecutionDiscipline<Turn<T, Request> | undefined, Y>(undefined);
  return {
    *start() {
      if (discipline.current() !== undefined) {
        throw new Error("Guest already started");
      }
      return yield* discipline.advance(() => driver.start());
    },
    *resume(outcome) {
      if (discipline.current()?.kind !== "suspended") {
        throw new Error("Guest is not suspended");
      }
      return yield* discipline.advance(() => driver.resume(outcome));
    },
    close: () => discipline.dispose(() => driver.close()),
  };
}
