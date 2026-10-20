/// <reference types="vite/client" />

declare module "#execution-lua-wasm" {
  const module: WebAssembly.Module;
  export default module;
}
