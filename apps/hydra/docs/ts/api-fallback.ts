// api-fallback.ts
import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

// Simulated APIs with different speeds/reliability
function* fetchFromPrimary(): Operation<string> {
  console.log('Trying primary API...');
  yield* sleep(2000); // Slow today!
  return 'Data from primary';
}

function* fetchFromBackup(): Operation<string> {
  console.log('Trying backup API...');
  yield* sleep(500);
  return 'Data from backup';
}

function* timeout(ms: number): Operation<never> {
  yield* sleep(ms);
  throw new Error(`Timeout after ${ms}ms`);
}

await main(function*() {
  console.log('Fetching data with 1s timeout per API...\n');
  
  // Try primary first with timeout
  let data: string;
  
  try {
    data = yield* race([
      fetchFromPrimary(),
      timeout(1000),
    ]);
    console.log('Got data from primary!');
  } catch (error) {
    console.log('Primary timed out, trying backup...\n');
    
    data = yield* race([
      fetchFromBackup(),
      timeout(1000),
    ]);
    console.log('Got data from backup!');
  }
  
  console.log('\nResult:', data);
});
