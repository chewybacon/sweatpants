import { it } from "vitest";
import { runPlayTttRuntimeInvariance } from "./play-ttt-runtime-invariance.helpers.ts";

it("reaches the golden outcome after the host disappears at frame 2", async () => {
  await runPlayTttRuntimeInvariance(2);
}, 30_000);
