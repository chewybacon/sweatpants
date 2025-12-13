import type { Operation } from 'effection';
import { main, action, race } from 'effection';

function sleep(ms: number): Operation<void> {
  return action(function(resolve, reject) {
    console.log(`Starting ${ms}ms timer`);
    const timeoutId = setTimeout(() => {
      console.log(`${ms}ms timer completed`);
      resolve();
    }, ms);

    return () => {
      console.log(`Cleaning up ${ms}ms timer`);
      clearTimeout(timeoutId);
    };
  });
}

await main(function*() {
  yield* race([sleep(10), sleep(1000)]);
  console.log('Race done!');
});
