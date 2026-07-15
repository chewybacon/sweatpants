import { register } from "tsx/esm/api";

register();

await import("./durable-program-worker.ts");
