import { call, createQueue, resource, type Operation } from "effection";
import type { ReactSchedulerDriver } from "@sweatpants/react-chat";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function createControlledScheduler(): {
  readonly driver: ReactSchedulerDriver;
  readonly pullCount: number;
  readonly releasedTickCount: number;
  reached(count: number): Operation<void>;
  release(): Operation<void>;
} {
  const ticks = createQueue<void, never>();
  const reached = new Map<Deferred, number>();
  let pulls = 0;
  let releasedTicks = 0;
  return {
    driver: {
      clock: () =>
        resource(function* (provide) {
          yield* provide({
            *next() {
              pulls += 1;
              for (const [waiter, count] of reached) {
                if (pulls >= count) {
                  waiter.resolve();
                  reached.delete(waiter);
                }
              }
              return yield* ticks.next();
            },
          });
        }),
    },
    get pullCount() {
      return pulls;
    },
    get releasedTickCount() {
      return releasedTicks;
    },
    *reached(count): Operation<void> {
      if (pulls < count) {
        const waiter = deferred();
        reached.set(waiter, count);
        yield* call(() => waiter.promise);
      }
    },
    *release(): Operation<void> {
      if (pulls <= releasedTicks) {
        throw new Error("No clock pull is waiting for a tick");
      }
      releasedTicks += 1;
      ticks.add(undefined);
    },
  };
}
