import { it } from "vitest";
import { runPlayTttRuntimeInvariance } from "./play-ttt-runtime-invariance.helpers.ts";

it("reaches the golden outcome after disconnect and graceful replacement at frame 2", async () => {
  await runPlayTttRuntimeInvariance(2);
}, 30_000);
