// context-basics.ts
import type { Operation, Context } from 'effection';
import { main, createContext } from 'effection';

// 1. Create a context with a name (for debugging)
const ConfigContext: Context<{ apiUrl: string }> = createContext<{ apiUrl: string }>('config');

function* fetchData(): Operation<string> {
  // 3. Access the context value from anywhere in the tree
  const config = yield* ConfigContext.expect();
  console.log('Fetching from:', config.apiUrl);
  return `Data from ${config.apiUrl}`;
}

function* processRequest(): Operation<void> {
  // This operation doesn't need to know about config
  const data: string = yield* fetchData();
  console.log('Got:', data);
}

await main(function*() {
  // 2. Set the context value
  yield* ConfigContext.set({ apiUrl: 'https://api.example.com' });
  
  yield* processRequest();
});
