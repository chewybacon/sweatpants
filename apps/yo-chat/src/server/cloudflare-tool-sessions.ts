import { createToolSessions } from "@sweatpants/tool-runtime-cloudflare/sessions";
import { workerTools } from "./worker-tools";

export const ToolSessions = createToolSessions({ tools: workerTools });
