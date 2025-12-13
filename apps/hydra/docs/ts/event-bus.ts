// event-bus.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

interface AppEvent {
  type: string;
  payload: unknown;
}

// Create a global event bus
const eventBus: Channel<AppEvent, void> = createChannel<AppEvent, void>();

// Logger that prints all events
function* eventLogger(): Operation<void> {
  for (const event of yield* each(eventBus)) {
    console.log(`[LOG] ${event.type}:`, event.payload);
    yield* each.next();
  }
}

// Analytics that counts events
function* analytics(): Operation<void> {
  const counts: Record<string, number> = {};
  
  for (const event of yield* each(eventBus)) {
    counts[event.type] = (counts[event.type] || 0) + 1;
    console.log(`[ANALYTICS] Event counts:`, counts);
    yield* each.next();
  }
}

await main(function*() {
  // Start consumers
  yield* spawn(eventLogger);
  yield* spawn(analytics);
  
  yield* sleep(10);
  
  // Emit some events
  yield* eventBus.send({ type: 'user.login', payload: { userId: 1 } });
  yield* eventBus.send({ type: 'page.view', payload: { page: '/home' } });
  yield* eventBus.send({ type: 'user.login', payload: { userId: 2 } });
  
  yield* sleep(100);
});
