// file-watcher.ts
import type { Operation, Channel } from 'effection';
import { main, resource, spawn, sleep, createChannel, each } from 'effection';

// Simulated file system events
interface FileEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
}

interface FileWatcher {
  events: Channel<FileEvent, void>;
}

function useFileWatcher(directory: string): Operation<FileWatcher> {
  return resource<FileWatcher>(function*(provide) {
    console.log(`Starting file watcher on ${directory}`);
    
    const events = createChannel<FileEvent, void>();
    
    // Simulate file system events
    yield* spawn(function*(): Operation<void> {
      const fakeEvents: FileEvent[] = [
        { type: 'create', path: `${directory}/file1.txt` },
        { type: 'modify', path: `${directory}/file2.txt` },
        { type: 'delete', path: `${directory}/file3.txt` },
      ];
      
      for (const event of fakeEvents) {
        yield* sleep(300);
        yield* events.send(event);
      }
    });
    
    try {
      yield* provide({ events });
    } finally {
      console.log('File watcher stopped');
    }
  });
}

await main(function*() {
  const watcher: FileWatcher = yield* useFileWatcher('./src');
  
  // Process events for 2 seconds
  yield* spawn(function*(): Operation<void> {
    yield* sleep(2000);
  });
  
  for (const event of yield* each(watcher.events)) {
    console.log(`[${event.type.toUpperCase()}] ${event.path}`);
    yield* each.next();
  }
});
