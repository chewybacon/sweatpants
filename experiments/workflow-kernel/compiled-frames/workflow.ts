function* choose(ctx, question) {
  "use workflow";
  const answer = yield* ctx.elicit(question);
  return answer;
}
function* plan(ctx, destination) {
  "use workflow";
  const seat = yield* choose(ctx, "Pick a seat");
  const confirmed = yield* ctx.elicit("Confirm booking");
  return [destination, seat, confirmed];
}
function* workflow(ctx) {
  "use workflow";
  const destination = yield* choose(ctx, "Pick a destination");
  const booking = yield* plan(ctx, destination);
  return booking;
}
