import { ensure, scoped } from 'effection';
function* helper(ctx) {
  "use workflow";
  yield* ensure(function* () {
    yield* ctx.elicit("helper cleanup");
  });
  return "helper returned";
}
function* workflow(ctx) {
  "use workflow";
  yield* ensure(function* () {
    yield* ctx.elicit("outer cleanup");
  });
  const result = yield* scoped(function* () {
    yield* ensure(function* () {
      yield* ctx.elicit("inner cleanup");
    });
    const deep = yield* scoped(function* () {
      yield* ensure(function* () {
        try {
          yield* ctx.elicit("deep cleanup");
        } finally {
          yield* ctx.elicit("deep finally");
        }
      });
      const ignored = yield* helper(ctx);
      const answer = yield* ctx.elicit("body");
      return answer;
    });
    yield* ctx.elicit("after deep scope");
    return deep;
  });
  yield* ctx.elicit("after inner scope");
  return result;
}
