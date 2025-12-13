// database-context.ts
import type { Operation, Context } from 'effection';
import { main, createContext, resource, sleep, ensure } from 'effection';

interface DatabaseConnection {
  query: (sql: string) => string;  // Sync for simplicity in this example
}

const DatabaseContext: Context<DatabaseConnection> = createContext<DatabaseConnection>('database');

// Database resource that sets context
function* useDatabase(): Operation<DatabaseConnection> {
  return yield* resource<DatabaseConnection>(function*(provide) {
    console.log('Connecting to database...');
    
    const connection: DatabaseConnection = {
      query: (sql: string) => {
        console.log('Executing:', sql);
        return JSON.stringify([{ id: 1, name: 'Test' }]);
      },
    };
    
    yield* ensure(() => console.log('Disconnecting from database...'));
    
    // Set the context so all children can access it
    yield* DatabaseContext.set(connection);
    
    yield* provide(connection);
  });
}

// Repository that uses the context
function* findUsers(): Operation<string> {
  const db: DatabaseConnection = yield* DatabaseContext.expect();
  return db.query('SELECT * FROM users');
}

function* findPosts(): Operation<string> {
  const db: DatabaseConnection = yield* DatabaseContext.expect();
  return db.query('SELECT * FROM posts');
}

await main(function*() {
  yield* useDatabase();
  
  // These operations access the database via context
  const users = yield* findUsers();
  const posts = yield* findPosts();
  
  console.log('Users:', users);
  console.log('Posts:', posts);
});
