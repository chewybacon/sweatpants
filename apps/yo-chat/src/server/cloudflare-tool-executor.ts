import { createToolExecutor } from "@sweatpants/tool-runtime-cloudflare/executor";
import { pickCard } from "../tools/pick-card/durable";
import { playTttTool } from "../tools/play-ttt/tool";

export default createToolExecutor({ tools: [pickCard, playTttTool] });
