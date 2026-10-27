import type { RuntimeTool } from "@sweatpants/agent-sdk";
import { bookFlightTool } from "./tools/book-flight.ts";

/** The standalone tracer owns its own tool inventory. */
const runtimeTools = new Map<string, RuntimeTool>([[bookFlightTool.name, bookFlightTool]]);

export function getRuntimeMcpTool(name: string): RuntimeTool | undefined {
  return runtimeTools.get(name);
}

export function runtimeMcpToolNames(): string[] {
  return Array.from(runtimeTools.keys());
}
