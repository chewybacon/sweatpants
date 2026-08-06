import { it } from "vitest";
import { runPlayTttRuntimeInvariance } from "./play-ttt-runtime-invariance.helpers.ts";

it("reaches the golden outcome after the host disappears at frame 6", async () => {
  await runPlayTttRuntimeInvariance(6);
}, 30_000);
