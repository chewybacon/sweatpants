import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'approaches/readable-stream-bridge': 'src/approaches/readable-stream-bridge.ts',
    'approaches/async-iterable-response': 'src/approaches/async-iterable-response.ts',
    'approaches/scope-captured-stream': 'src/approaches/scope-captured-stream.ts',
    'approaches/effection-server': 'src/approaches/effection-server.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
