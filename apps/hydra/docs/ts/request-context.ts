// request-context.ts
import type { Operation, Context } from 'effection';
import { main, createContext, spawn, sleep } from 'effection';

interface RequestInfo {
  id: string;
  userId: number;
  startTime: number;
}

const RequestContext: Context<RequestInfo> = createContext<RequestInfo>('request');

function* logAccess(resource: string): Operation<void> {
  const req: RequestInfo = yield* RequestContext.expect();
  const elapsed = Date.now() - req.startTime;
  console.log(`[${req.id}] User ${req.userId} accessed ${resource} (+${elapsed}ms)`);
}

function* fetchProfile(): Operation<void> {
  yield* logAccess('/profile');
  yield* sleep(50);
}

function* fetchSettings(): Operation<void> {
  yield* logAccess('/settings');
  yield* sleep(30);
}

function* handleRequest(id: string, userId: number): Operation<void> {
  yield* RequestContext.set({
    id,
    userId,
    startTime: Date.now(),
  });
  
  yield* fetchProfile();
  yield* fetchSettings();
  yield* logAccess('/done');
}

await main(function*() {
  yield* spawn(() => handleRequest('req-1', 42));
  yield* spawn(() => handleRequest('req-2', 17));
  
  yield* sleep(200);
});
