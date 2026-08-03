import { createContext } from "effection";

import type { PersonaResolver } from "@sweatpants/chat-core";
import type { McpToolRegistry } from "@sweatpants/chat-core";
import type { ToolSessionRegistry, ToolSessionStore } from "@sweatpants/tool-session";
import type { PluginSessionManager } from "./durable-handler/plugin-session-manager.ts";

export const PersonaResolverContext = createContext<PersonaResolver>("PersonaResolver");
export const MaxIterationsContext = createContext<number>("MaxIterations");

export const McpToolRegistryContext = createContext<McpToolRegistry>("McpToolRegistry");

export const PluginSessionStoreContext = createContext<ToolSessionStore>("PluginSessionStore");
export const PluginSessionRegistryContext =
  createContext<ToolSessionRegistry>("PluginSessionRegistry");
export const PluginSessionManagerContext =
  createContext<PluginSessionManager>("PluginSessionManager");
