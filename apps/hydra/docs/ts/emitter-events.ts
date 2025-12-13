// emitter-events.ts
import type { Operation, Signal } from 'effection';
import { main, createSignal, spawn, sleep, each, ensure } from 'effection';
import { EventEmitter } from 'events';

interface DataEvent {
  id: number;
  value: string;
}

function* streamEvents(emitter: EventEmitter): Operation<void> {
  const events: Signal<DataEvent, void> = createSignal<DataEvent, void>();
  const errors: Signal<Error, void> = createSignal<Error, void>();
  
  // Attach handlers (regular functions)
  const onData = (data: DataEvent) => events.send(data);
  const onError = (err: Error) => errors.send(err);
  
  emitter.on('data', onData);
  emitter.on('error', onError);
  
  yield* ensure(() => {
    emitter.off('data', onData);
    emitter.off('error', onError);
    events.close();
    errors.close();
  });
  
  // Process events
  for (const event of yield* each(events)) {
    console.log('Data event:', event);
    yield* each.next();
  }
}

// Demo
await main(function*() {
  const emitter = new EventEmitter();
  
  // Start consuming events
  yield* spawn(() => streamEvents(emitter));
  
  yield* sleep(10);
  
  // Emit some events
  emitter.emit('data', { id: 1, value: 'first' });
  emitter.emit('data', { id: 2, value: 'second' });
  emitter.emit('data', { id: 3, value: 'third' });
  
  yield* sleep(100);
});
