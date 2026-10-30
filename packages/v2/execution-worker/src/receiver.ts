import type { Composition } from "@standard-durability/core";
import type { Guest, GuestResponse, Turn } from "@sweatpan.ts/execution";
import type { GuestCommandReceiver } from "./types.ts";

/** Serialize command advancement; any advancement failure fences this incarnation. */
export function createGuestCommandReceiver<R, Q, Y, V, E>(
  composition: Composition<Y>,
  incarnation: string,
  guest: Guest<R, Q, Y, V, E>,
): GuestCommandReceiver<R, Q, Y, V, E> {
  let sequence = 0;
  let busy = false;
  let dead = false;
  return {
    *receive(command) {
      const identity = { incarnation: command.incarnation, sequence: command.sequence };
      if (command.incarnation !== incarnation || command.sequence !== sequence || busy || dead) {
        return { ...identity, kind: "error", message: "Stale or unavailable Guest command" };
      }
      sequence++;
      busy = true;
      let finished = false;
      try {
        const response = yield* composition.catchError<GuestResponse<R, Q>, GuestResponse<R, Q>>(
          function* () {
            if (command.action === "close") {
              dead = true;
              yield* guest.close();
              return { ...identity, kind: "closed" };
            }
            let turn: Turn<R, Q>;
            if (command.action === "start") {
              turn = yield* guest.start();
            } else if (command.action === "resume") {
              turn = yield* guest.resume(command.outcome);
            } else {
              if (!guest.cancel) {
                throw new Error("Guest cancellation is unsupported");
              }
              turn = yield* guest.cancel(command.reason);
            }
            return { ...identity, kind: "turn", turn };
          },
          function* (error) {
            dead = true;
            return {
              ...identity,
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
            };
          },
        );
        finished = true;
        return response;
      } finally {
        busy = false;
        if (!finished) {
          dead = true;
        }
      }
    },
  };
}
