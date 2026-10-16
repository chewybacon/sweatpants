import { ensure } from "effection";
function* child(ctx) {
  "use workflow";
  yield* ensure(function* () {
    try {
      yield* ctx.elicit("child ensure");
    } finally {
      yield* ctx.elicit("ensure finally");
    }
  });
  try {
    const answer = yield* ctx.elicit("body");
    return answer;
  } finally {
    yield* ctx.elicit("child finally");
    yield* ensure(function* () {
      yield* ctx.elicit("registered in finally");
    });
  }
}
function* workflow(ctx) {
  "use workflow";
  yield* ensure(function* () {
    yield* ctx.elicit("outer ensure");
  });
  try {
    const result = yield* child(ctx);
    yield* ctx.elicit("parent continued");
    return result;
  } finally {
    yield* ctx.elicit("parent finally");
  }
}
