import { useScope, resource, createContext } from "effection"

const Provider = createContext<number>('provider')

function* setter(value: number) {
  const scope = yield* useScope();
  const current = (yield* Provider.expect()) ?? 0;

  const val = value + current;
  scope.set(Provider, val);

  return yield* resource<number>(function* (provide) {
    try {
      yield* provide(val);
    } finally {
      scope.set(Provider, current);
    }
  });
}

