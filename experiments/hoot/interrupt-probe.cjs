// Node-only containment probe. This is not an interpreter instruction budget.
const { Worker } = require("node:worker_threads");
const worker = new Worker(
  `
  const { parentPort, workerData } = require('node:worker_threads');
  const { Scheme } = require(workerData + '/runtime/reflect.js');
  (async () => {
    const [start] = await Scheme.load_main(workerData + '/runtime/kernel.wasm', {
      reflect_wasm_dir: workerData + '/runtime'
    });
    parentPort.postMessage('entering-unbounded-program');
    start.call('(let loop () (loop))');
    parentPort.postMessage('unexpected-return');
  })().catch(error => { throw error; });
`,
  { eval: true, workerData: __dirname },
);
const startupDeadline = setTimeout(() => {
  worker.terminate();
  console.error("Interpreter did not start within 10 seconds");
  process.exitCode = 1;
}, 10000);
worker.once("error", (error) => {
  clearTimeout(startupDeadline);
  console.error(error);
  process.exitCode = 1;
});
worker.once("message", (message) => {
  clearTimeout(startupDeadline);
  if (message !== "entering-unbounded-program") {
    throw new Error(message);
  }
  setTimeout(async () => {
    const exitCode = await worker.terminate();
    console.log(
      JSON.stringify({
        runtime: "node-worker-thread",
        terminated: true,
        exitCode,
        budgetMs: 250,
        conclusion:
          "Host can terminate runaway WASM; no in-interpreter fuel or workerd per-step limit proven",
      }),
    );
  }, 250);
});
