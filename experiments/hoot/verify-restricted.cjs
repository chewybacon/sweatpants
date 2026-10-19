const { Scheme } = require("./runtime/reflect-restricted.cjs");
(async () => {
  const { restrictionScenarios } = await import("./restriction-scenarios.mjs");
  const result = await restrictionScenarios(() =>
    Scheme.load_main(__dirname + "/runtime/restricted.wasm", {
      reflect_wasm_dir: __dirname + "/runtime",
    }),
  );
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
