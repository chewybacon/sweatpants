import { assertJsonObject } from "@sweatpants/foundation";
import type { AnyToolContract } from "@sweatpants/agent-sdk";
import type { ToolInventoryEntry } from "./chat-runtime-contract.ts";

/**
 * Projects an execution-neutral authored contract into a runtime inventory entry.
 *
 * The portable projection was computed and digested once when the tool was
 * authored. Re-deriving it here would be a second, unverified answer to a
 * question already settled at the authoring boundary. The one narrowing that
 * remains is real: `true` and `false` are legal JSON Schema documents, while a
 * tool inventory entry must advertise a keyed parameter schema.
 */
export function createToolInventoryEntry(
  tool: AnyToolContract,
  metadata?: Record<string, unknown>,
): ToolInventoryEntry {
  const projection = assertJsonObject(
    tool.artifacts.parameters.inputProjection,
    `tool ${tool.name} parameters`,
  );
  const { $id: _id, $schema: _schema, ...parameters } = projection;
  return {
    definition: { name: tool.name, description: tool.description, parameters },
    capabilities: {
      elicits: Boolean(tool.capabilities?.elicitation),
      samples: Boolean(tool.capabilities?.sampling),
    },
    ...(metadata ? { metadata } : {}),
  };
}
