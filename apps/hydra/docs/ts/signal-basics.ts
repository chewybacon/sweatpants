// signal-basics.ts
import type { Signal } from 'effection';
import { main, createSignal, each } from 'effection';

await main(function*() {
  // Create a signal
  const clicks: Signal<string, void> = createSignal<string, void>();
  
  // clicks.send is a REGULAR FUNCTION - can be used anywhere!
  setTimeout(() => clicks.send('click 1'), 100);
  setTimeout(() => clicks.send('click 2'), 200);
  setTimeout(() => clicks.send('click 3'), 300);
  setTimeout(() => clicks.close(), 400);
  
  // Consume as a stream (same as channel)
  for (const click of yield* each(clicks)) {
    console.log('Received:', click);
    yield* each.next();
  }
  
  console.log('Done');
});
