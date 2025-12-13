// countdown.ts
import type { Operation } from 'effection';
import { main, sleep } from 'effection';

function* countdown(seconds: number): Operation<void> {
  for (let i = seconds; i > 0; i--) {
    console.log(`${i}...`);
    yield* sleep(1000);
  }
  console.log('Done!');
}

await main(function*() {
  yield* countdown(5);
});
