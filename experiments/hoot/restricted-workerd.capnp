using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (
    compatibilityDate = "2026-10-01",
    modules = [
      (name = "worker.mjs", esModule = embed "restricted-worker.mjs"),
      (name = "restriction-scenarios.mjs", esModule = embed "restriction-scenarios.mjs"),
      (name = "scenarios.mjs", esModule = embed "scenarios.mjs"),
      (name = "reflect-restricted.mjs", esModule = embed "runtime/reflect-restricted.mjs"),
      (name = "restricted.wasm", wasm = embed "runtime/restricted.wasm"),
      (name = "reflect.wasm", wasm = embed "runtime/reflect.wasm"),
      (name = "wtf8.wasm", wasm = embed "runtime/wtf8.wasm")
    ]
  ))],
  sockets = [(name = "http", address = "127.0.0.1:8125", http = (), service = "main")]
);
