// Only infrastructure imports required by the component. Guest OS requests are
// rejected by the adapter; no filesystem, environment or network is exposed.
export function createWasiImports() {
  function Unavailable() {
    throw Error("WASI resource unavailable");
  }
  class OutputStream {
    checkWrite() {
      return 65536n;
    }
    write() {
      throw Error("Unexpected WASI output");
    }
    blockingWriteAndFlush() {
      throw Error("Unexpected WASI output");
    }
    flush() {}
    [Symbol.dispose]() {}
  }
  return {
    "wasi:cli/environment": { getEnvironment: () => [] },
    "wasi:cli/exit": {
      exit: () => {
        throw Error("Monty worker exited");
      },
    },
    "wasi:cli/stderr": { getStderr: () => new OutputStream() },
    "wasi:cli/stdout": { getStdout: () => new OutputStream() },
    "wasi:cli/stdin": {
      getStdin: () => {
        throw Error("No stdin");
      },
    },
    "wasi:clocks/monotonic-clock": { now: () => BigInt(Math.floor(performance.now() * 1e6)) },
    "wasi:clocks/wall-clock": {
      now: () => ({ seconds: BigInt(Math.floor(Date.now() / 1000)), nanoseconds: 0 }),
    },
    "wasi:filesystem/preopens": { getDirectories: () => [] },
    "wasi:filesystem/types": { Descriptor: Unavailable, filesystemErrorCode: () => undefined },
    "wasi:io/error": { Error: Unavailable },
    "wasi:io/streams": { InputStream: Unavailable, OutputStream },
    "wasi:random/random": {
      getRandomBytes: (length) => crypto.getRandomValues(new Uint8Array(Number(length))),
    },
  };
}
