import { Context as NativeContext, Effect, Scope } from "effect";
import type {
  Api,
  Composition,
  Context,
  Middleware,
  Operations,
  Operation,
  Work,
} from "@sweatpants/standard-durability";

// Frames contain bindings only. Effect owns fibers, interruption and finalization.
type Invoke = (...args: unknown[]) => Operation<unknown, EffectYield>;
type Around = (args: unknown[], next: Invoke) => ReturnType<Invoke>;
type Decoration = { at: "min" | "max"; methods: Record<string, Around | undefined> };
interface Frame {
  readonly parent?: Frame;
  readonly scope: Scope.Scope;
  readonly values: Map<string, unknown>;
  readonly drivers: Map<string, Record<string, Invoke>>;
  readonly middleware: Map<string, Decoration[]>;
  closed: boolean;
}
export class CompositionFrame extends NativeContext.Service<CompositionFrame, Frame>()(
  "standard-durability/experimental/frame",
) {}
export type EffectYield = Effect.Effect<unknown, never, CompositionFrame | Scope.Scope>;

export function execute<T>(work: Work<T, EffectYield>) {
  return Effect.gen(function* () {
    return yield* work();
  });
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
  createApi<Signature extends object>(
    name: string,
    defaults: Operations<Signature, EffectYield>,
  ): Api<Signature, EffectYield> {
    if (Object.values(defaults).some((value) => typeof value !== "function")) {
      throw new TypeError("API declarations must contain only operation methods");
    }
    // Erasure is confined to dynamic dispatch; the public mapped types retain each
    // method's argument/result relation, as in the reference adapter.
    const core = defaults as unknown as Record<string, Invoke>;
    const operations = Object.fromEntries(
      Object.keys(defaults).map((key) => [
        key,
        (...args: unknown[]) =>
          Effect.flatMap(CompositionFrame, (frame) => {
            const chain = ancestors(frame);
            const all = chain.flatMap((current) => current.middleware.get(name) ?? []);
            // Middleware may enter a child scope before invoking its continuation.
            // Resolve only the terminal core there, without redispatching wrappers.
            const terminal: Invoke = (...input) =>
              Effect.flatMap(CompositionFrame, (current) => {
                const target =
                  ancestors(current)
                    .reverse()
                    .find((ancestor) => ancestor.drivers.has(name))
                    ?.drivers.get(name) ?? core;
                return execute(() => Reflect.apply(target[key]!, target, input));
              });
            const ordered = [
              ...all.filter((entry) => entry.at === "max"),
              ...all.filter((entry) => entry.at === "min").reverse(),
            ];
            const invoke = ordered.reduceRight<Invoke>((next, entry) => {
              const middleware = entry.methods[key];
              return middleware ? (...input) => middleware(input, next) : next;
            }, terminal);
            return execute(() => invoke(...args));
          }),
      ]),
    ) as unknown as Operations<Signature, EffectYield>;
    function decorate(
      frame: Frame,
      methods: Record<string, Around | undefined>,
      at: "min" | "max",
    ) {
      check(frame);
      const entries = frame.middleware.get(name) ?? [];
      // Snapshot method selection at installation, matching native decoration.
      entries.push({ at, methods: { ...methods } });
      frame.middleware.set(name, entries);
    }
    return {
      operations,
      around: (middleware: Middleware<Signature, EffectYield>, options) =>
        Effect.map(CompositionFrame, (frame) => {
          decorate(frame, middleware as Record<string, Around | undefined>, options?.at ?? "max");
        }),
      install: (driver) =>
        Effect.map(CompositionFrame, (frame) => {
          check(frame);
          if (frame.drivers.has(name)) {
            throw new Error(`Driver already installed in this scope: ${name}`);
          }
          frame.drivers.set(name, driver as unknown as Record<string, Invoke>);
        }),
    };
  },
};
