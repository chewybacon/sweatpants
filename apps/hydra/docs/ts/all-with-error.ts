// all-with-error.ts
import type { Operation } from 'effection';
import { main, all, sleep } from 'effection';

function* fetchData(id: number): Operation<string> {
  console.log(`Starting fetch ${id}`);
  yield* sleep(id * 100);
  if (id === 2) {
    console.log(`Fetch ${id} FAILED`);
    throw new Error('Fetch 2 failed!');
  }
  console.log(`Completed fetch ${id}`);
  return `Data ${id}`;
}

await main(function*() {
  try {
    const results: string[] = yield* all([
      fetchData(1),
      fetchData(2),  // This throws after 200ms
      fetchData(3),  // This gets halted!
    ]);
    console.log(results);
  } catch (error) {
    console.log('Caught:', (error as Error).message);
  }
});
