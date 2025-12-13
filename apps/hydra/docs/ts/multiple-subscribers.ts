// multiple-subscribers.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

await main(function*() {
  const channel: Channel<string, void> = createChannel<string, void>();
  
  // Two subscribers
  yield* spawn(function*(): Operation<void> {
    console.log('Subscriber A starting');
    for (const msg of yield* each(channel)) {
      console.log('A received:', msg);
      yield* each.next();
    }
    console.log('Subscriber A done');
  });
  
  yield* spawn(function*(): Operation<void> {
    console.log('Subscriber B starting');
    for (const msg of yield* each(channel)) {
      console.log('B received:', msg);
      yield* each.next();
    }
    console.log('Subscriber B done');
  });
  
  // Give subscribers time to start
  yield* sleep(10);
  
  // Send messages
  yield* channel.send('hello');
  yield* channel.send('world');
  yield* channel.close();
  
  yield* sleep(100);
});
