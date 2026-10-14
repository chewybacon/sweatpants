const { Scheme } = require('./runtime/reflect.js');
(async () => {
  const { scenarios } = await import('./scenarios.mjs');
  const started = Date.now();
  const result = await scenarios(() => Scheme.load_main(__dirname + '/runtime/kernel.wasm', {
    reflect_wasm_dir: __dirname + '/runtime'
  }));
  console.log(JSON.stringify({runtime: 'node', elapsedMs: Date.now() - started, ...result}, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
