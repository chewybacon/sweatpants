import type { ChatToolDefinition } from "@sweatpants/chat-contract";
import { ToolExposureApi } from "@sweatpants/chat-core";
import { ToolInventoryApi } from "@sweatpants/tool-runtime";
import { MaxIterationsContext, PersonaResolverContext } from "../contexts.ts";
import { useLogger } from "../logger/index.ts";
import type { ChatRequestBody, ToolSchema } from "./types.ts";
function definitionToToolSchema(definition: ChatToolDefinition): ToolSchema {
  return {
    name: definition.name,
    description: definition.description ?? "",
    parameters: definition.parameters,
  };
}

/** Applies server inventory, persona selection, and exposure policy for this Turn. */
export function* prepareChatTools(
  body: ChatRequestBody,
  sessionId: string,
  requestedConversationId: string,
  maxToolIterations: number | null,
) {
  const log = yield* useLogger("handler:durable");
  const inventoryEntries = yield* ToolInventoryApi.list();
  const inventoryNames = new Set(inventoryEntries.map((entry) => entry.definition.name));
  const inventoryNameList = inventoryEntries.map((entry) => entry.definition.name);
  log.debug(
    { toolCount: inventoryEntries.length, toolNames: inventoryNameList },
    "tool inventory configured",
  );

  const resolvePersona = yield* PersonaResolverContext.get();
  const maxIterations = (yield* MaxIterationsContext.get()) ?? maxToolIterations;

  // Build tool schemas
  const enabledToolNames = new Set<string>();
  let exposeCompleteInventory = false;
  let systemPrompt: string | undefined;

  // Handle persona mode vs manual mode
  if (body.persona) {
    if (!resolvePersona) {
      throw new Error("Persona mode not supported - no resolver configured");
    }

    const resolved = resolvePersona(
      body.persona,
      body.personaConfig,
      body.enableOptionalTools,
      body.effort,
    );

    systemPrompt = resolved.systemPrompt;

    for (const toolName of resolved.tools) {
      if (inventoryNames.has(toolName)) {
        enabledToolNames.add(toolName);
      } else {
        throw new Error(`Unknown persona tool: ${toolName}`);
      }
    }
  } else {
    // Manual mode presents the complete inventory installed by the
    // Host. Client plugins and wire metadata never select inventory.
    exposeCompleteInventory = true;
    for (const name of inventoryNameList) {
      enabledToolNames.add(name);
    }

    if (body.systemPrompt) {
      systemPrompt = body.systemPrompt;
    }
  }

  // Build model-facing tool schemas through server inventory + exposure policy.
  // Client plugin registration never participates in executable selection.
  const exposedDefinitions = yield* ToolExposureApi.definitions({
    phase: "outer-chat",
    entries: inventoryEntries,
    request: body,
    // This is a Host-selected presentation set. Authorization still
    // comes from `entries`, the scoped executable inventory.
    enabledTools: exposeCompleteInventory ? true : Array.from(enabledToolNames),
    metadata: { sessionId, conversationId: requestedConversationId },
  });

  log.debug(
    {
      exposedToolNames: exposedDefinitions.map((definition) => definition.name),
    },
    "tool exposure resolved",
  );

  const seenNames = new Set<string>();
  const toolSchemas: ToolSchema[] = [];
  for (const schema of exposedDefinitions.map(definitionToToolSchema)) {
    if (!seenNames.has(schema.name)) {
      seenNames.add(schema.name);
      toolSchemas.push(schema);
    }
  }

  return { inventoryEntries, toolSchemas, systemPrompt, maxIterations };
}
