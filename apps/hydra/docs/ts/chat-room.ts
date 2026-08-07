// chat-room.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

interface HydraChatMessage {
  user: string;
  text: string;
  timestamp: Date;
}

const chatChannel: Channel<HydraChatMessage, void> = createChannel<HydraChatMessage, void>();

function* chatClient(username: string): Operation<void> {
  console.log(`${username} joined the chat`);
  
  for (const msg of yield* each(chatChannel)) {
    if (msg.user !== username) {
      console.log(`[${username}'s view] ${msg.user}: ${msg.text}`);
    }
    yield* each.next();
  }
}

function* sendMessage(user: string, text: string): Operation<void> {
  yield* chatChannel.send({
    user,
    text,
    timestamp: new Date(),
  });
}

await main(function*() {
  // Start chat clients
  yield* spawn(() => chatClient('Alice'));
  yield* spawn(() => chatClient('Bob'));
  yield* spawn(() => chatClient('Charlie'));
  
  yield* sleep(10);
  
  // Simulate conversation
  yield* sendMessage('Alice', 'Hello everyone!');
  yield* sleep(100);
  yield* sendMessage('Bob', 'Hi Alice!');
  yield* sleep(100);
  yield* sendMessage('Charlie', 'Good morning!');
  
  yield* sleep(200);
});
