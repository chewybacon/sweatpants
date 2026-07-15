import { register } from "tsx/esm/api";

register();

await import("./durable-pick-card-worker.ts");
