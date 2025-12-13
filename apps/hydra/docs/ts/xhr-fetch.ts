import type { Operation } from 'effection';
import { main, action, race } from 'effection';

function* fetchUrl(url: string): Operation<string> {
  return yield* action<string>((resolve, reject) => {
    const controller = new AbortController();
    
    console.log(`Starting request to ${url}`);
    
    fetch(url, { signal: controller.signal })
      .then(response => response.text())
      .then(text => {
        console.log(`Completed request to ${url}`);
        resolve(text);
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          reject(err);
        }
      });

    return () => {
      console.log(`Aborting request to ${url}`);
      controller.abort();
    };
  });
}

// If you race two fetch operations, the loser's HTTP request is actually cancelled!
await main(function*() {
  const result: string = yield* race([
    fetchUrl('https://httpbin.org/delay/1'),
    fetchUrl('https://httpbin.org/delay/2'),
  ]);
  console.log('Winner:', result.slice(0, 100) + '...');
});
