import { register } from "tsx/esm/api";
register();
await import("./durable-worker.ts");
