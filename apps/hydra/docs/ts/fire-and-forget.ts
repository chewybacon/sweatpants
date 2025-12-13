// fire-and-forget.ts
import type { Operation } from 'effection';
import { main, spawn, sleep } from 'effection';

function* doMainWork(): Operation<void> {
  console.log('Doing main work...');
  yield* sleep(3000);
  console.log('Main work done!');
}

await main(function*() {
  // Start a background heartbeat - we don't need its result
  yield* spawn(function*(): Operation<void> {
    while (true) {
      console.log('heartbeat');
      yield* sleep(1000);
    }
  });
  
  // Do other work...
  yield* doMainWork();
  
  // When main ends, heartbeat is automatically stopped
});
