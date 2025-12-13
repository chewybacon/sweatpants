// effection-race.ts
import { main, sleep, race } from 'effection';

await main(function*() {
  console.time('race');
  yield* race([
    sleep(10),
    sleep(1000)
  ]);
  console.timeEnd('race');
});
