// each-pattern.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

await main(function*() {
  const channel: Channel<number, void> = createChannel<number, void>();
  
  // Producer
  yield* spawn(function*(): Operation<void> {
    for (let i = 1; i <= 5; i++) {
      yield* channel.send(i);
      yield* sleep(100);
    }
    yield* channel.close();
  });
  
  // Consumer with each()
  for (const value of yield* each(channel)) {
    console.log('Got:', value);
    yield* each.next();  // REQUIRED!
  }
  
  console.log('Done');
});
