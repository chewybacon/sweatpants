import type { ToolExposurePolicy } from "@sweatpants/chat-core";
import { createTisynTool } from "./tisyn.ts";
import { echo } from "./tools/echo.ts";
import { ask } from "./tools/ask.ts";

export const boundTools = [echo, ask];
export const tisyn = createTisynTool(boundTools);
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
