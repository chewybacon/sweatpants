import { register } from "tsx/esm/api";

register();

await import("./acceptance-durable-worker.ts");
