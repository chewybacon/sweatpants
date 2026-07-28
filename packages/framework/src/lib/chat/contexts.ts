import { createContext } from "effection";

import type { PersonaResolver } from "./setup-types.ts";
import type { PluginRegistry } from "./mcp-tools/plugin-registry.ts";
import type { McpToolRegistry } from "../../handler/durable/types.ts";
import type { ToolSessionRegistry, ToolSessionStore } from "@sweatpants/tool-session";
import type { PluginSessionManager } from "../../handler/durable/plugin-session-manager.ts";

export const PersonaResolverContext = createContext<PersonaResolver>("PersonaResolver");
export const MaxIterationsContext = createContext<number>("MaxIterations");

export const PluginRegistryContext = createContext<PluginRegistry>("PluginRegistry");
export const McpToolRegistryContext = createContext<McpToolRegistry>("McpToolRegistry");

export const PluginSessionStoreContext = createContext<ToolSessionStore>("PluginSessionStore");
export const PluginSessionRegistryContext =
  createContext<ToolSessionRegistry>("PluginSessionRegistry");
export const PluginSessionManagerContext =
  createContext<PluginSessionManager>("PluginSessionManager");
