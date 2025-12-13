import type { Operation, Task } from 'effection';
import { main, spawn, sleep } from 'effection';

await main(function*() {
  const task: Task<string> = yield* spawn(function*(): Operation<string> {
    yield* sleep(1000);
    return 'completed!';
  });

  // Wait for it to finish
  const result: string = yield* task;
  console.log(result); // 'completed!'
});

