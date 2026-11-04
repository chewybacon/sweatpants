import type { Api, Composition } from "@standard-durability/core";
import type { Journal, OwnedJournal } from "@sweatpan.ts/durable";
import { readJournalPresentation } from "./presentation.ts";
import type {
  JournalPresentation,
  AttemptNotifications,
  ChildRunner,
  ActivationDriver,
} from "./contracts.ts";
/** Optional bound runner facade; pass operations.run to existing all/race installation. */
export function createChildRunner<C, I, Y>(
  composition: Composition<Y>,
  name: string,
  driver: ChildRunner<C, I, Y>,
): Api<ChildRunner<C, I, Y>, Y> {
  return composition.createApi<ChildRunner<C, I, Y>>(name, {
    operations: driver,
  });
}
/** Scoped notification transport selection. Signals retain their original delivery scope/driver. */
export function createAttemptNotifications<Y>(
  composition: Composition<Y>,
  name: string,
  driver: AttemptNotifications<Y>,
): Api<AttemptNotifications<Y>, Y> {
  return composition.createApi<AttemptNotifications<Y>>(name, {
    operations: driver,
  });
}
/** Bind one execution's read-only presentation source to ordinary scoped policy. */
export function createJournalPresentation<R, Q, V, E, S, Y>(
  composition: Composition<Y>,
  name: string,
  journal: Pick<Journal<R, Q, V, E, S, Y>, "read"> & Pick<OwnedJournal<R, Q, V, E, S, Y>, "id">,
): Api<JournalPresentation<R, Q, V, E, Y>, Y> {
  return composition.createApi<JournalPresentation<R, Q, V, E, Y>>(name, {
    operations: {
      read: (after, limit) => readJournalPresentation(journal, after, limit),
    },
  });
}
/** Bind one activation owner to scoped start policy. Preserve this facade at consumers. */
export function createActivationDriver<Result, Y>(
  composition: Composition<Y>,
  name: string,
  driver: ActivationDriver<Result, Y>,
): Api<ActivationDriver<Result, Y>, Y> {
  return composition.createApi<ActivationDriver<Result, Y>>(name, {
    operations: driver,
  });
}
