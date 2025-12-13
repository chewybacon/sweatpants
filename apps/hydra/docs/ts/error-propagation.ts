// error-propagation.ts
import type { Operation } from 'effection';
import { main, spawn, sleep } from 'effection';

await main(function*() {
  yield* spawn(function*(): Operation<void> {
    yield* sleep(100);
    throw new Error('Child failed!');
  });
  
  yield* spawn(function*(): Operation<void> {
    yield* sleep(1000);  // This will be halted!
    console.log('Never reached');
  });
  
  yield* sleep(2000);
  console.log('Also never reached');
});
