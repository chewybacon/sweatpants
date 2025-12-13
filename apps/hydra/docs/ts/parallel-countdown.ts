// parallel-countdown.ts
import type { Operation, Task } from 'effection';
import { main, spawn, sleep } from 'effection';

function* countdown(name: string, seconds: number): Operation<string> {
  for (let i = seconds; i > 0; i--) {
    console.log(`${name}: ${i}`);
    yield* sleep(1000);
  }
  console.log(`${name}: Done!`);
  return `${name} finished`;
}

await main(function*() {
  console.log('Starting parallel countdowns...\n');
  
  const task1: Task<string> = yield* spawn(() => countdown('Alpha', 3));
  const task2: Task<string> = yield* spawn(() => countdown('Beta', 5));
  const task3: Task<string> = yield* spawn(() => countdown('Gamma', 2));
  
  // Wait for all to complete
  const result1: string = yield* task1;
  const result2: string = yield* task2;
  const result3: string = yield* task3;
  
  console.log('\nAll done!');
  console.log(result1, result2, result3);
});
