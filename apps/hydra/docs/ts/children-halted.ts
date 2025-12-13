// children-halted.ts
import type { Operation } from 'effection';
import { main, spawn, sleep } from 'effection';

await main(function*() {
  yield* spawn(function*(): Operation<void> {
    let count = 0;
    while (true) {
      console.log(`tick ${++count}`);
      yield* sleep(100);
    }
  });
  
  yield* sleep(550);
  console.log('main ending...');
  // main ends, the infinite loop is halted!
});
