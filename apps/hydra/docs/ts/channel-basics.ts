// channel-basics.ts
import type { Operation, Channel, Subscription } from 'effection';
import { main, createChannel, spawn, sleep } from 'effection';

await main(function*() {
  // Create a channel that sends strings
  const channel: Channel<string, void> = createChannel<string, void>();
  
  // Subscribe BEFORE sending (channels don't buffer)
  const subscription: Subscription<string, void> = yield* channel;
  
  // Send some messages in the background
  yield* spawn(function*(): Operation<void> {
    yield* channel.send('hello');
    yield* sleep(100);
    yield* channel.send('world');
    yield* sleep(100);
    yield* channel.close();  // Close the channel
  });
  
  // Receive messages
  let result = yield* subscription.next();
  while (!result.done) {
    console.log('Received:', result.value);
    result = yield* subscription.next();
  }
  
  console.log('Channel closed');
});
