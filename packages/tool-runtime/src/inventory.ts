import type { AnyToolContract } from "@sweatpants/agent-sdk";
import { requireJsonObject } from "@sweatpants/foundation";
import { createContext, type Operation } from "effection";
import type { ToolInventoryEntry } from "./contract.ts";

export interface ToolInventory {
  list(): Operation<ToolInventoryEntry[]>;
  resolve(name: string): Operation<ToolInventoryEntry | null>;
}

export class ToolInventoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolInventoryError";
  }
}

export const ToolInventoryContext = createContext<ToolInventory>("ToolInventory");

export function createToolInventory(entries: ToolInventoryEntry[]): ToolInventory {
  const ordered = [...entries];
  const byName = new Map<string, ToolInventoryEntry>();

  for (const entry of ordered) {
    const name = entry.definition.name;
    if (!name) {
      throw new ToolInventoryError(
        "TOOL_NAME_INVALID",
        "Tool inventory entry requires a canonical definition.name",
      );
    }
    if (byName.has(name)) {
      throw new ToolInventoryError(
        "TOOL_NAME_DUPLICATE",
        `Duplicate tool name in inventory: ${name}`,
      );
    }
    byName.set(name, entry);
  }

  return {
    *list(): Operation<ToolInventoryEntry[]> {
      return ordered;
    },
    *resolve(name: string): Operation<ToolInventoryEntry | null> {
      return byName.get(name) ?? null;
    },
  };
}

export const ToolInventoryApi = {
  *list(): Operation<ToolInventoryEntry[]> {
    const inventory = yield* ToolInventoryContext.get();
    if (!inventory) {
      throw new ToolInventoryError(
        "TOOL_INVENTORY_NOT_CONFIGURED",
        "Tool inventory not configured. Install a ToolInventory in scope.",
      );
    }
    return yield* inventory.list();
  },

  *resolve(name: string): Operation<ToolInventoryEntry> {
    const inventory = yield* ToolInventoryContext.get();
    if (!inventory) {
      throw new ToolInventoryError(
        "TOOL_INVENTORY_NOT_CONFIGURED",
        "Tool inventory not configured. Install a ToolInventory in scope.",
      );
    }
    const entry = yield* inventory.resolve(name);
    if (!entry) {
      throw new ToolInventoryError("TOOL_NOT_FOUND", `Tool not found: ${name}`);
    }
    return entry;
  },
};

/** Projects an authored tool and its retained portable artifacts into runtime inventory. */
export function createToolInventoryEntry(
  tool: AnyToolContract,
  metadata?: Record<string, unknown>,
): ToolInventoryEntry {
  const projection = requireJsonObject(
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
