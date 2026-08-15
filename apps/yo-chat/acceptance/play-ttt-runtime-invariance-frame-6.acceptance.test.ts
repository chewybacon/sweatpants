import { it } from "vitest";
import { runPlayTttRuntimeInvariance } from "./play-ttt-runtime-invariance.helpers.ts";

it("reaches the golden outcome after disconnect and graceful replacement at frame 6", async () => {
  await runPlayTttRuntimeInvariance(6);
}, 30_000);
