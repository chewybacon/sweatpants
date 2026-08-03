import { makePlugin } from "./frontend.ts";
import { aliasedOrdinary, durableTool } from "./barrel.ts";
import defaultTool from "./default-tool.ts";

export const plugins = [
  makePlugin(aliasedOrdinary),
  makePlugin(durableTool),
  makePlugin(defaultTool),
];
