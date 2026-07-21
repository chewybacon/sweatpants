// Source-mode loader shim for the generated production worker entry.
//
// Node worker threads do not inherit tsx loader hooks early enough to parse all
// workspace TypeScript dependencies. Register in-thread, then execute the exact
// generated module used by the Vite ?modulePath production boundary. This file
// contains no registry or tool invocation behavior.
import { register } from "tsx/esm/api";

register();

await import("../__generated__/tool-worker.gen.ts");
