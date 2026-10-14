using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (
    compatibilityDate = "2026-10-01",
    modules = [
      (name = "worker.mjs", esModule = embed "worker.mjs"),
      (name = "scenarios.mjs", esModule = embed "scenarios.mjs"),
      (name = "reflect-worker.mjs", esModule = embed "runtime/reflect-worker.mjs"),
      (name = "kernel.wasm", wasm = embed "runtime/kernel.wasm"),
      (name = "reflect.wasm", wasm = embed "runtime/reflect.wasm"),
      (name = "wtf8.wasm", wasm = embed "runtime/wtf8.wasm")
    ]
  ))],
  sockets = [(name = "http", address = "127.0.0.1:8124", http = (), service = "main")]
);
