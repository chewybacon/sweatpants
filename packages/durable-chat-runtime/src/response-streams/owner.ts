import {
  call,
  createContext,
  createScope,
  suspend,
  useScope,
  type Operation,
  type Scope,
} from "effection";
import type { OwnedTaskHandle } from "./owned-task.ts";

/** Structural Host/Turn owner used to supervise response-stream writers. */
export interface DurableStreamsOwner {
  readonly scope: Scope;
  readonly register: (work: OwnedTaskHandle<void>) => void;
}

/** Host supervision boundary needed to parent one durable Turn. */
export interface DurableTurnHost {
  readonly scope: Scope;
  register(work: { isDone(): boolean; waitForDone(): Operation<unknown> }): void;
}

/** A distinct Host child that owns every durable branch for one Turn. */
export interface DurableTurnOwner extends DurableStreamsOwner {
  isDone(): boolean;
  waitForDone(): Operation<void>;
  /** Declares that request setup has finished registering durable branches. */
  seal(): void;
  /** Tears down an incompletely configured Turn. */
  abort(): Operation<void>;
}

/**
 * Creates a reclaimable Turn scope beneath the Host, never beneath a consumer.
 * The Turn closes after setup is sealed and all registered durable work joins.
 */
export function* createDurableTurnOwner(
  host: DurableTurnHost,
  setup?: () => Operation<void>,
): Operation<DurableTurnOwner> {
  const [containerScope, destroyScope] = createScope(host.scope);
  const active = new Set<OwnedTaskHandle<void>>();
  let scope!: Scope;
  let sealed = false;
  let done = false;
  let finishing = false;
  let resolveDone!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (): void => {
    if (!sealed || active.size > 0 || done || finishing) return;
    finishing = true;
    void host.scope
      .run(function* () {
        yield* call(() => destroyScope());
        done = true;
        resolveDone();
      })
      .catch(() => {
        done = true;
        resolveDone();
      });
  };

  const owner: DurableTurnOwner = {
    get scope() {
      return scope;
    },
    register(work) {
      if (done || finishing) throw new Error("Cannot register work after the Turn has closed");
      active.add(work);
      void host.scope
        .run(function* () {
          yield* work.waitForDone();
          active.delete(work);
          finish();
        })
        .catch(() => {
          active.delete(work);
          finish();
        });
    },
    isDone: () => done,
    *waitForDone() {
      if (!done) yield* call(() => completion);
    },
    seal() {
      sealed = true;
      finish();
    },
    *abort() {
      if (done) return;
      sealed = true;
      finishing = true;
      if (active.size === 0) {
        done = true;
        resolveDone();
        void host.scope.run(function* () {
          yield* call(() => destroyScope());
        });
        return;
      }
      yield* call(() => destroyScope());
      done = true;
      resolveDone();
    },
  };

  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void containerScope
    .run(function* () {
      scope = yield* useScope();
      yield* installDurableStreamsOwner(owner);
      if (setup) yield* setup();
      resolveReady();
      yield* suspend();
    })
    .catch(rejectReady);
  try {
    yield* call(() => ready);
  } catch (error) {
    yield* call(() => destroyScope());
    throw error;
  }
  host.register(owner);
  return owner;
}

const DurableStreamsOwnerContext = createContext<DurableStreamsOwner | undefined>(
  "sweatpants-durable-streams-owner",
  undefined,
);

export function* installDurableStreamsOwner(owner: DurableStreamsOwner): Operation<void> {
  yield* DurableStreamsOwnerContext.set(owner);
}

export function useDurableStreamsOwner(): Operation<DurableStreamsOwner | undefined> {
  return DurableStreamsOwnerContext.get();
}
