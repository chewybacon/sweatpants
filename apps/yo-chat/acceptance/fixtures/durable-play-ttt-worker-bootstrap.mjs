import { register } from "tsx/esm/api";

register();

await import("./durable-play-ttt-worker.ts");
