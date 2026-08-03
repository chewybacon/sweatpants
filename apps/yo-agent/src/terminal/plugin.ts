import {
  createPluginBuilder,
  type PluginBuilder,
  type PluginToolContract,
} from "@sweatpants/tool-session/mcp";
import type { TerminalElicitCapabilities } from "./interaction.ts";

export function makeTerminalPlugin<TContract extends PluginToolContract>(
  tool: TContract,
): PluginBuilder<TContract, TerminalElicitCapabilities> {
  return createPluginBuilder<TerminalElicitCapabilities, TContract>(tool);
}
