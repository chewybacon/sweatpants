// keyboard-stream.ts
import type { Operation, Signal } from 'effection';
import { main, createSignal, each, ensure } from 'effection';
import * as readline from 'readline';

function* keyboardInput(): Operation<void> {
  const lines: Signal<string, void> = createSignal<string, void>();
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  rl.on('line', lines.send);
  
  yield* ensure(() => {
    rl.close();
    lines.close();
  });
  
  console.log('Type messages (Ctrl+C to exit):\n');
  
  for (const line of yield* each(lines)) {
    console.log(`You typed: "${line}"`);
    yield* each.next();
  }
}

await main(function*() {
  yield* keyboardInput();
});
