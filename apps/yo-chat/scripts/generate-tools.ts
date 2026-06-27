import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { toolDiscoveryPlugin } from '../../../packages/vite-plugin/src/index.ts'

const appRoot = fileURLToPath(new URL('..', import.meta.url))

const plugin = toolDiscoveryPlugin({
  dir: 'src/tools',
  outFile: 'src/__generated__/tool-registry.gen.ts',
  pattern: '**/*.{ts,tsx}',
  generateWorker: true,
  workerOutFile: 'src/__generated__/tool-worker.gen.ts',
})

async function callConfigResolved(nextPlugin: Plugin): Promise<void> {
  if (typeof nextPlugin.configResolved === 'function') {
    await nextPlugin.configResolved({ root: appRoot } as never)
  }
}

async function callBuildStart(nextPlugin: Plugin): Promise<void> {
  const hook = nextPlugin.buildStart
  if (!hook) return
  if (typeof hook === 'function') {
    await hook.call({} as never, {} as never)
    return
  }
  await hook.handler.call({} as never, {} as never)
}

await callConfigResolved(plugin)
await callBuildStart(plugin)
