import { serveWorkerGuest } from "@sweatpants/tool-runtime-local/worker";
import type { PortableToolWorkerInput } from "@sweatpants/tool-runtime-local";
import { createToolGuest } from "@sweatpants/tool-session/execution/tool-guest";
import type { ToolDefinition } from "@sweatpants/agent-sdk";
import { tools as definitions } from "./tool-definitions.ts";

// Worker identity selects a heterogeneous registry; concrete result inference ends here.
const tools: readonly ToolDefinition[] = definitions;

serveWorkerGuest(function* ({ tool: identity, input, callId }: PortableToolWorkerInput) {
  const tool = tools.find((entry) => entry.name === identity.name);
  if (
    !tool ||
    tool.version !== identity.version ||
    tool.interfaceDigest !== identity.interfaceDigest
  ) {
    throw new Error("Tool worker declaration does not match its execution route");
  }
  return createToolGuest(tool, input, callId);
});
