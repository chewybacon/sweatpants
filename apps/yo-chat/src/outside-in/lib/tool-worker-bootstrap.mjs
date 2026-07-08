// Plain-JS worker bootstrap for Tier A (design R2 / Decision 2).
//
// The `web-worker` shim does not forward `execArgv`, and ESM loader hooks are
// not inherited by worker threads. So instead of relying on `--import tsx`, this
// bootstrap (loaded as plain JS by the worker thread) registers tsx IN-THREAD
// and then imports the generated TypeScript tool-worker entry. The result: the
// REAL tools run their `execute` generators inside a genuine worker thread,
// preserving the serialization boundary — with no dependency on parent flags.
import { register } from "tsx/esm/api";

register();

await import("../../__generated__/tool-worker.gen.ts");
