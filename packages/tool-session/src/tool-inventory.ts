import { z } from "zod";
import type { AnyToolContract } from "@sweatpants/agent-sdk";
import type { ToolInventoryEntry } from "./chat-runtime-contract.ts";
import { toToolParameterJsonSchema } from "./tool-parameters.ts";

/** Projects an execution-neutral authored contract into a runtime inventory entry. */
export function createToolInventoryEntry(
  tool: AnyToolContract,
  metadata?: Record<string, unknown>,
): ToolInventoryEntry {
  const projection = tool.artifacts?.parameters?.inputProjection;
  let parameters: Record<string, unknown>;
  const parsedProjection = z.record(z.string(), z.json()).safeParse(projection);
  if (parsedProjection.success) {
    const { $id: _id, $schema: _schema, ...rest } = parsedProjection.data;
    parameters = rest;
  } else {
    parameters = toToolParameterJsonSchema(tool.parameters);
  }
  return {
    definition: { name: tool.name, description: tool.description, parameters },
    capabilities: {
      elicits: Boolean(tool.capabilities?.elicitation),
      samples: Boolean(tool.capabilities?.sampling),
    },
    ...(metadata ? { metadata } : {}),
  };
}
