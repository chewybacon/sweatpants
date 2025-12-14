import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

await main(function*() {
  const channel: Channel<string, void> = createChannel<string, void>();

  yield* spawn(function*(): Operation<void> {
    yield* channel.send('task-1');
    yield* channel.send('task-2');
    yield* channel.send('task-3');
    yield* channel.close();
  });

  for (const task of yield* each(channel)) {
    console.log('Processing:', task);
    yield* sleep(500);  // Simulate slow processing
    console.log('Finished:', task);
    yield* each.next();  // Now request next item
  }
});

