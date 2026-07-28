/**
 * chat-core/plugin-spec.ts
 *
 * Minimal structural type for the plugin shape that session/options.ts
 * needs. The full PluginHandleInput type (with MCP-specific elicitation
 * schemas, artifacts, and execution kinds) remains in framework/mcp-tools;
 * it is structurally compatible with this spec.
 */
import type { Operation } from "effection";

export interface PluginReplayTraceSpec {
  client: {
    toolName: string;
    replayTrace?: (trace: unknown) => Operation<unknown>;
  };
}
