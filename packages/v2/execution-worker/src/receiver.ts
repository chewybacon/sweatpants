import type { Composition, Operation } from "@standard-durability/core";
import {
  createProgramExecution,
  type Guest,
  type Turn,
  type ProgramExecution,
} from "@sweatpan.ts/execution";
import type { GuestWorkerOptions } from "./contracts.ts";
import type { GuestCommandReceiver } from "./types.ts";

/** Lazily acquire or restore one pinned incarnation; checkpointing never replaces a live Guest. */
export function* createGuestCommandReceiver<R, Q, Y, V, E>(
  composition: Composition<Y>,
  options: GuestWorkerOptions<R, Q, Y, V, E>,
): Operation<GuestCommandReceiver<Y, V, E>, Y> {
  let execution: Pick<ProgramExecution<R, Q, Y, V, E>, "acquire" | "checkpoints"> | undefined =
    options.acquire ? { acquire: options.acquire, checkpoints: options.checkpoints } : undefined;
  let guest: Guest<R, Q, Y, V, E> | undefined;
  function* closeGuest() {
    const closing = guest;
    guest = undefined;
    if (closing) {
      yield* closing.close();
    }
  }
  yield* composition.ensure(closeGuest);
  let sequence = 0;
  let busy = false;
  let dead = false;
  return {
    *receive(command) {
      if (
        command.incarnation !== options.incarnation ||
        command.sequence !== sequence ||
        busy ||
        dead
      ) {
        throw new Error("Stale or unavailable Guest command");
      }
      sequence++;
      busy = true;
      let finished = false;
      try {
        if (command.action === "close") {
          dead = true;
          yield* closeGuest();
          finished = true;
          return undefined;
        }
        if (command.action === "initialize") {
          if (execution || !options.resolve) {
            throw new Error("Guest incarnation is already initialized");
          }
          execution = createProgramExecution({
            invocation: command.invocation,
            resolve: options.resolve,
            checkpointFormat: command.checkpointFormat,
          });
          finished = true;
          return undefined;
        }
        if (!execution) {
          throw new Error("Guest incarnation requires initialization");
        }
        if (command.action === "restore" || command.action === "capture") {
          const adapter = execution.checkpoints;
          if (!adapter || adapter.format !== command.format) {
            throw new Error("Unsupported Guest checkpoint format");
          }
          if (command.action === "capture") {
            if (!guest) {
              throw new Error("Cannot capture an unacquired Guest");
            }
            const state = yield* adapter.capture(guest);
            finished = true;
            return state;
          }
          if (guest) {
            throw new Error("Cannot restore over a live Guest");
          }
          const restored = yield* adapter.restore(command.state);
          guest = restored.guest;
          finished = true;
          return restored.turn;
        }
        if (!guest) {
          if (command.action !== "start") {
            throw new Error("Guest has not been acquired");
          }
          guest = yield* execution.acquire();
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
        finished = true;
        return turn;
      } finally {
        busy = false;
        if (!finished) {
          dead = true;
        }
      }
    },
  };
}
