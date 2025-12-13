// spawn-example.ts
import type { Operation, Task } from 'effection';
import { main, spawn, sleep } from 'effection';

function* fetchFromAPI(source: string): Operation<string> {
  console.log(`Fetching from ${source}...`);
  yield* sleep(500);
  return `Data from ${source}`;
}

await main(function*() {
  console.time('total');
  
  const taskA: Task<string> = yield* spawn(() => fetchFromAPI('api-a'));
  const taskB: Task<string> = yield* spawn(() => fetchFromAPI('api-b'));
  
  const dataA: string = yield* taskA;
  const dataB: string = yield* taskB;
  
  console.log(dataA, dataB);
  console.timeEnd('total'); // ~500ms - parallel!
});
