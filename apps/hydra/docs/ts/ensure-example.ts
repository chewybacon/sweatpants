// ensure-example.ts
import type { Operation } from 'effection';
import { main, resource, ensure, sleep } from 'effection';

interface Connection {
  query: (sql: string) => string;
}

function useDatabase(): Operation<Connection> {
  return resource<Connection>(function*(provide) {
    console.log('Connecting to database...');
    yield* sleep(100); // Simulate connection time
    
    const connection: Connection = {
      query: (sql: string) => `Result of: ${sql}`,
    };
    
    // ensure() is cleaner than try/finally for simple cleanup
    yield* ensure(() => {
      console.log('Disconnecting from database...');
    });
    
    console.log('Database connected!');
    yield* provide(connection);
  });
}

await main(function*() {
  const db: Connection = yield* useDatabase();
  
  console.log(db.query('SELECT * FROM users'));
  
  yield* sleep(100);
  
  // cleanup runs when main ends
});
