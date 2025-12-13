// http-server-resource.ts
import type { Operation } from 'effection';
import { main, resource, ensure, suspend } from 'effection';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';

interface HttpServer {
  server: Server;
  port: number;
}

function useHttpServer(port: number): Operation<HttpServer> {
  return resource<HttpServer>(function*(provide) {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Hello from Effection!\n');
    });
    
    // Start listening
    server.listen(port);
    console.log(`Server starting on port ${port}...`);
    
    // Ensure cleanup
    yield* ensure(() => {
      console.log('Closing server...');
      server.close();
    });
    
    // Provide the server to the caller
    yield* provide({ server, port });
  });
}

await main(function*() {
  const { port }: HttpServer = yield* useHttpServer(3000);
  
  console.log(`Server running at http://localhost:${port}`);
  console.log('Press Ctrl+C to stop\n');
  
  // Keep running until interrupted
  yield* suspend();
});
