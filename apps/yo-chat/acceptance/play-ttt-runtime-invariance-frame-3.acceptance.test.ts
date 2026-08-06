import { it } from "vitest";
import { runPlayTttRuntimeInvariance } from "./play-ttt-runtime-invariance.helpers.ts";

it("reaches the golden outcome after the host disappears at frame 3", async () => {
  await runPlayTttRuntimeInvariance(3);
}, 30_000);
