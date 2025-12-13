// guaranteed-cleanup.ts
import { main, sleep } from 'effection';

await main(function*() {
  try {
    yield* sleep(100000);
  } finally {
    console.log('Cleaning up...');  // ALWAYS runs!
  }
});

// Ctrl+C triggers graceful shutdown
