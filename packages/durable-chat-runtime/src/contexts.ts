import { createContext } from "effection";

import type { PersonaResolver } from "@sweatpants/chat-core";
import type { McpToolRegistry } from "@sweatpants/chat-core";

export const PersonaResolverContext = createContext<PersonaResolver>("PersonaResolver");
export const MaxIterationsContext = createContext<number>("MaxIterations");

export const McpToolRegistryContext = createContext<McpToolRegistry>("McpToolRegistry");
