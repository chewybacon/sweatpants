let channel = createChannel();
yield* spawn(function*() {
  for (let item of yield* each(channel)) {
    yield* doStuffWithItem(item);
    yield* each.next();
  }
});
yield* channel.send(thing);
