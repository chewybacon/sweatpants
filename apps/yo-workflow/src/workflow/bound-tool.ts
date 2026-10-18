import type { AnyToolContract } from "@sweatpants/agent-sdk";
import type { DurableTool } from "@sweatpants/durable-execution";

export type BoundTool = DurableTool & AnyToolContract;
