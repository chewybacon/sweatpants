import { ensure } from 'effection';
function* workflow(ctx) {
  "use workflow";
  let remaining = 3;
  while (remaining > 0) {
    const hold = yield* ctx.elicit('acquire');
    let local = 0;
    yield* ensure(function* () {
      yield* ctx.elicit(hold, remaining, local);
    });
    local = local + 1;
    remaining = remaining - 1;
  }
  yield* ctx.elicit('ready');
  return remaining;
}
