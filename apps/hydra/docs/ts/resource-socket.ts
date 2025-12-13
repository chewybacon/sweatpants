// resource-socket.ts
import type { Operation } from 'effection';
import { main, resource, action, sleep } from 'effection';
import { EventEmitter } from 'events';

// Fake socket for demo
class FakeSocket extends EventEmitter {
  connect() { setTimeout(() => this.emit('connect'), 100); }
  send(msg: string) { console.log('Sending:', msg); }
  close() { console.log('Socket closed'); }
}

function useSocket(): Operation<FakeSocket> {
  return resource<FakeSocket>(function*(provide) {
    const socket = new FakeSocket();
    socket.connect();
    
    // Wait for connection - NOTE: action() takes a regular function, not a generator!
    yield* action<void>((resolve) => {
      socket.once('connect', resolve);
      return () => {};
    });
    
    console.log('Socket connected!');
    
    try {
      // provide() gives the socket to the caller AND suspends
      yield* provide(socket);
    } finally {
      socket.close();
    }
  });
}

await main(function*() {
  const socket: FakeSocket = yield* useSocket();
  
  socket.send('hello');
  socket.send('world');
  
  yield* sleep(100);
  
  // When main ends, the resource cleans up
});
