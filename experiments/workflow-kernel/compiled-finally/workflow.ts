function* child(ctx) {
  "use workflow";
  try {
    const answer = yield* ctx.elicit("body");
    return answer;
  } finally {
    yield* ctx.elicit("child cleanup 1");
    yield* ctx.elicit("child cleanup 2");
  }
}
function* workflow(ctx) {
  "use workflow";
  try {
    const result = yield* child(ctx);
    yield* ctx.elicit("parent continued");
    return result;
  } finally {
    yield* ctx.elicit("parent cleanup");
  }
}
