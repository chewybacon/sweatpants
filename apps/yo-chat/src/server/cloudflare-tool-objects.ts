import { createToolExecutorObject } from "@sweatpants/tool-runtime-cloudflare/executor";
import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";

export const ToolExecutors = createToolExecutorObject({ tools: [pickCard, playTttTool] });
