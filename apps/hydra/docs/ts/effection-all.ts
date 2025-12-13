// effection-all.ts
import type { Operation } from 'effection';
import { main, all, sleep } from 'effection';

function* fetchData(id: number): Operation<string> {
  console.log(`Starting fetch ${id}`);
  yield* sleep(id * 100);
  console.log(`Completed fetch ${id}`);
  return `Data ${id}`;
}

await main(function*() {
  const results: string[] = yield* all([
    fetchData(1),
    fetchData(2),
    fetchData(3),
  ]);
  
  console.log(results); // ['Data 1', 'Data 2', 'Data 3']
});
