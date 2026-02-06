import { runToolWorker } from '../../runner.ts'

await runToolWorker(function* () {
  throw new Error('worker crash')
})
