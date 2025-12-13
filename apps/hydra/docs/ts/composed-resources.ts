// composed-resources.ts
import type { Operation } from 'effection';
import { main, resource, spawn, sleep } from 'effection';
import { EventEmitter } from 'events';

// Fake socket
class FakeSocket extends EventEmitter {
  connect() { setTimeout(() => this.emit('connect'), 50); }
  send(msg: string) { console.log('>> Sending:', msg); }
  close() { console.log('Socket closed'); }
}

function useSocket(): Operation<FakeSocket> {
  return resource<FakeSocket>(function*(provide) {
    const socket = new FakeSocket();
    socket.connect();
    
    yield* sleep(50); // Wait for connect
    
    try {
      yield* provide(socket);
    } finally {
      socket.close();
    }
  });
}

// A socket with automatic heartbeat
function useHeartbeatSocket(): Operation<FakeSocket> {
  return resource<FakeSocket>(function*(provide) {
    // Use another resource!
    const socket: FakeSocket = yield* useSocket();
    
    // Start heartbeat in background
    yield* spawn(function*(): Operation<void> {
      while (true) {
        yield* sleep(500);
        socket.send('heartbeat');
      }
    });
    
    // Provide the socket
    yield* provide(socket);
    
    // Cleanup: when this resource ends, the spawned heartbeat
    // is automatically halted (child of this resource)
  });
}

await main(function*() {
  const socket: FakeSocket = yield* useHeartbeatSocket();
  
  socket.send('hello');
  
  yield* sleep(1200);  // Let some heartbeats happen
  
  socket.send('goodbye');
  
  // When main ends:
  // 1. useHeartbeatSocket's spawn is halted (heartbeat stops)
  // 2. useSocket's finally runs (socket.close())
});
