// Plain-JS worker bootstrap: register tsx in this worker thread, then load the
// TypeScript probe entry. Keeps the worker independent of parent execArgv / the
// web-worker shim (which does not forward execArgv).
import { register } from "tsx/esm/api";
register();
await import("./worker-probe.worker.ts");
