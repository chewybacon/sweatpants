import { executeWork } from "./execute.ts";
import { Context as NativeContext, Effect, Scope, Cause } from "effect";
import {
  composeOperation,
  type Api,
  type ApiDefaults,
  type OperationMethods,
  type Composition,
  type Context,
  type Work,
} from "@standard-durability/core";
import {
  describeSync,
  assertSynchronous,
  readMember,
  bindMembers,
  synchronousDecorator,
  mergeDriver,
  type RawInvoke,
} from "@standard-durability/core/internal";
import type { CompositionScope, EffectYield } from "./contracts.ts";
import type { Decoration, Frame, Invoke } from "./types.ts";

// Frames contain bindings only. Effect owns fibers, interruption and finalization.
class CompositionFrame extends NativeContext.Service<CompositionScope, Frame>()(
  "standard-durability/composition/frame",
) {}

/**
 * Adapt portable work inside the current native scope and composition bindings.
 * Use effectProgram for a fresh root. Register physical cleanup with composition.ensure
 * or runtime.using; arbitrary yielding finally blocks are not a portable cleanup guarantee.
 */
export function execute<T>(
  work: Work<T, EffectYield>,
): Effect.Effect<T, never, CompositionScope | Scope.Scope> {
  return executeWork(work);
}

function check(frame: Frame) {
  if (frame.closed) {
    throw new Error("Composition scope is closed");
  }
}
function ancestors(frame: Frame): Frame[] {
  const result: Frame[] = [];
  for (let current: Frame | undefined = frame; current; current = current.parent) {
    check(current);
    result.unshift(current);
  }
  return result;
}
function owned<T>(work: Work<T, EffectYield>, parent?: Frame): Effect.Effect<T> {
  return Effect.scopedWith((scope) => {
    const frame: Frame = {
      parent,
      scope,
      values: new Map(),
      drivers: new Map(),
      middleware: new Map(),
      closed: false,
    };
    return Effect.gen(function* () {
      // Registered first, so user finalizers can still resolve bindings during cleanup.
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          frame.closed = true;
        }),
      );
      return yield* execute(work).pipe(
        Effect.provideService(CompositionFrame, frame),
        Effect.provideService(Scope.Scope, scope),
      );
    });
  });
}

/** Root ownership boundary. Each invocation gets independent bindings and cleanup. */
export function effectProgram<T>(work: Work<T, EffectYield>): Effect.Effect<T> {
  // Defer frame allocation until execution, including repeated runs of one description.
  return Effect.suspend(() => owned(work));
}

export const effect: Composition<EffectYield> = {
  catchError(work, recover) {
    return Effect.catchCause(execute(work), (cause) => {
      const reason = cause.reasons[0];
      // Never turn interruption or combined operation/cleanup failure into a retry.
      if (cause.reasons.length !== 1 || !reason || !Cause.isDieReason(reason)) {
        return Effect.failCause(cause);
      }
      return execute(() => recover(reason.defect));
    });
  },
  scoped(work) {
    return Effect.flatMap(CompositionFrame, (parent) => {
      check(parent);
      return owned(work, parent);
    });
  },
  ensure(cleanup) {
    return Effect.flatMap(CompositionFrame, (frame) => {
      check(frame);
      return Scope.addFinalizer(
        frame.scope,
        execute(cleanup).pipe(
          Effect.provideService(CompositionFrame, frame),
          Effect.provideService(Scope.Scope, frame.scope),
        ),
      );
    });
  },
  createContext<T>(name: string): Context<T, EffectYield> {
    const get = () =>
      Effect.map(CompositionFrame, (frame) => {
        const chain = ancestors(frame);
        for (const current of chain.reverse()) {
          if (current.values.has(name)) {
            return current.values.get(name) as T;
          }
        }
        return undefined;
      });
    return {
      get,
      expect: () =>
        Effect.map(get(), (value) => {
          if (value === undefined) {
            throw new Error(`Missing context: ${name}`);
          }
          return value;
        }),
      set: (value) =>
        Effect.map(CompositionFrame, (frame) => {
          check(frame);
          frame.values.set(name, value);
        }),
    };
  },
  createApi<O extends OperationMethods<O, EffectYield> = {}, S extends object = {}>(
    name: string,
    defaults: ApiDefaults<O, S>,
  ): Api<O, EffectYield, S> {
    const members = describeSync(defaults.sync);
    function driver(frame: Frame) {
      return (
        ancestors(frame)
          .reverse()
          .find((ancestor) => ancestor.drivers.has(name))
          ?.drivers.get(name) ?? defaults
      );
    }
    function layers(frame: Frame) {
      const all = ancestors(frame).flatMap((current) => current.middleware.get(name) ?? []);
      return [
        ...all.filter((entry) => entry.at === "max"),
        ...all.filter((entry) => entry.at === "min").reverse(),
      ];
    }
    function invokeSync(frame: Frame, key: string, args: unknown[]) {
      const terminal: RawInvoke = (...input) =>
        assertSynchronous(readMember(driver(frame).sync ?? {}, key, input, members.get(key)!));
      const invoke = composeOperation(
        terminal,
        layers(frame).map((entry) => {
          const layer = entry.sync[key];
          return layer && synchronousDecorator(layer);
        }),
      );
      return assertSynchronous(invoke(...args));
    }
    const operations = Object.fromEntries(
      Object.keys(defaults.operations ?? {}).map((key) => [
        key,
        (...args: unknown[]) =>
          Effect.flatMap(CompositionFrame, (frame) => {
            // next() remains lazy so a decorator can enter a child before driving it.
            const terminal: Invoke = (...input) =>
              Effect.flatMap(CompositionFrame, (current) =>
                execute(
                  () =>
                    readMember(
                      driver(current).operations ?? {},
                      key,
                      input,
                      "method",
                    ) as ReturnType<Invoke>,
                ),
              );
            const invoke = composeOperation(
              terminal,
              layers(frame).map(
                (entry) => entry.operations[key] as ((next: Invoke) => Invoke) | undefined,
              ),
            );
            return execute(() => invoke(...args));
          }),
      ]),
    ) as unknown as O;
    return {
      operations,
      around: (middleware, options) =>
        Effect.map(CompositionFrame, (frame) => {
          check(frame);
          const entries = frame.middleware.get(name) ?? [];
          entries.push({
            at: options?.at ?? "max",
            operations: { ...middleware.operations },
            sync: { ...middleware.sync },
          } as Decoration);
          frame.middleware.set(name, entries);
        }),
      install: (replacement) =>
        Effect.map(CompositionFrame, (frame) => {
          check(frame);
          if (frame.drivers.has(name)) {
            throw new Error(`Driver already installed in this scope: ${name}`);
          }
          frame.drivers.set(name, mergeDriver(driver(frame), replacement));
        }),
      *[Symbol.iterator]() {
        const frame = yield* CompositionFrame;
        check(frame);
        let active = true;
        yield* Scope.addFinalizer(
          frame.scope,
          Effect.sync(() => {
            active = false;
          }),
        );
        return bindMembers(members, (key, args) => {
          if (!active) {
            throw new Error("API access scope is closed");
          }
          return invokeSync(frame, key, args);
        }) as Readonly<S>;
      },
    };
  },
};
