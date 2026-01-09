import { Context, Effect, Layer, Exit, Console } from "effect";
import { UnknownException } from "effect/Cause";
import { Operation, createScope, suspend, sleep } from "effection";

interface Runtime {
  run: <T>(operation: Operation<T>) => Effect.Effect<T, UnknownException>;
}

const Runtime = Context.GenericTag<Runtime>("effection");

function makeRuntime() {
  return Layer.effect(
    Runtime,
    Effect.gen(function*() {
      const [scope, close] = createScope();

      const run: Runtime["run"] = (operation) => {
        return Effect.tryPromise(() =>
          scope.run(function*() {
            return yield* operation;
          })
        );
      };

      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          const _ = yield* Effect.tryPromise(close).pipe(Effect.exit);
          yield* Console.log("closing", _);
        })
      );

      return { run };
    })
  );
}

function* task() {
  try {
    yield* suspend();
  } finally {
    console.log("effection:exiting");
  }
}

const program = Effect.gen(function*() {
  const runtime = yield* Runtime;
  const result = yield* runtime.run(task()).pipe(Effect.fork);
  console.log("task", result);
  yield* Effect.sleep(4000);
  return result;
});

const runtime = makeRuntime();

Effect.runPromiseExit(program.pipe(Effect.provide(runtime), Effect.scoped))
  .then(console.log)
  .catch(console.error);


//
//
//
//

import {
  Console,
  Context,
  Effect,
  Exit,
  Layer,
  Deferred,
  ManagedRuntime,
  Runtime as ERuntime,
} from "effect";
import { UnknownException } from "effect/Cause";
import {
  call,
  createContext,
  createScope,
  Operation,
  resource,
  run,
  sleep,
  spawn,
  suspend,
} from "effection";

interface Runtime {
  run: <A, E, R>(effect: Effect.Effect<A, E, never>) => Operation<A>;
}

const Runtime = createContext<Runtime>("effect");

function* makeRuntime() {
  return yield* resource<Runtime>(function*(provide) {
    const runtime = ManagedRuntime.make(Layer.empty);

    const run: Runtime["run"] = (effect) => {
      return call(() => runtime.runPromise(effect));
    };

    try {
      yield* provide({ run });
    } finally {
      yield* call(() => runtime.dispose());
    }
  });
}

const task = Effect.gen(function*() {
  yield* Effect.addFinalizer(() => Console.log("effect:exiting"));
  yield* Effect.sleep(10000);
  return 100;
});

const program = function*() {
  const runtime = yield* Runtime.expect();
  const result = yield* spawn(() => runtime.run(task.pipe(Effect.scoped)));
  console.log("task", result);
  yield* sleep(4000);
  return result;
};

run(function*() {
  const runtime = yield* makeRuntime();
  yield* Runtime.set(runtime);
  yield* program();
  console.log("done");
})
  .then(console.log)
  .catch(console.error);
