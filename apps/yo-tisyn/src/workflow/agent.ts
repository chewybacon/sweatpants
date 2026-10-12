import type { ToolExposurePolicy } from "@sweatpants/chat-core";
import { createTisynTool } from "./tisyn.ts";
import { echo } from "./tools/echo.ts";
import { ask } from "./tools/ask.ts";
import { sample } from "./tools/sample.ts";

export const samplingMode = process.env.PUBLIC_TISYN_SAMPLING ?? "child";
if (samplingMode !== "child" && samplingMode !== "direct") {
  throw new Error("PUBLIC_TISYN_SAMPLING must be child or direct");
}
export const boundTools = samplingMode === "direct" ? [echo, ask] : [echo, ask, sample];
const builder = createTisynTool(boundTools);
export const tisyn = (samplingMode === "direct" ? builder.samples() : builder).build();
export const programs = [tisyn, ...boundTools];
export const tisynExposure: ToolExposurePolicy = {
  *filter({ entries }) {
    if (!entries) {
      throw new Error("Tisyn requires an installed tool inventory");
    }
    return entries
      .filter((entry) => entry.definition.name === tisyn.name)
      .map((entry) => entry.definition);
  },
};
