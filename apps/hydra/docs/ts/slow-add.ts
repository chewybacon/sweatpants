// slow-add.ts
import type { Operation } from 'effection';
import { main, sleep } from 'effection';

function* slowAdd(a: number, b: number): Operation<number> {
  yield* sleep(1000);
  return a + b;
}

await main(function*() {
  const result: number = yield* slowAdd(2, 3);
  console.log(`Result: ${result}`); // Result: 5
});
