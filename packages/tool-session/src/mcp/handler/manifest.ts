import { requireJsonObject, type Json, type JsonObject } from "@sweatpants/foundation";
import type { AnyToolContract } from "@sweatpants/agent-sdk";
import { MCP_PROTOCOL_VERSION } from "../protocol-version.ts";

type ListedTool = AnyToolContract;
type McpElicitProjection = { response: JsonObject; context?: JsonObject };
type McpToolProjection = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  _meta?: {
    "x-sweatpants": {
      elicits?: Record<string, McpElicitProjection>;
      requires?: { elicitation?: boolean; sampling?: boolean };
    };
  };
};

/** JSON Schema was authored and digested upstream; this only applies MCP's keyed constraint. */
function portableSchemaObject(projection: Json, label: string): JsonObject {
  const { $id: _id, $schema: _schema, ...schema } = requireJsonObject(projection, label);
  return schema;
}

function projectElicits(tool: ListedTool): Record<string, McpElicitProjection> | undefined {
  const entries = Object.entries(tool.artifacts.elicits).map(([key, artifact]) => [
    key,
    {
      response: portableSchemaObject(
        artifact.response.inputProjection,
        `tool ${tool.name} elicitation ${key} response`,
      ),
      ...(artifact.context
        ? {
            context: portableSchemaObject(
              artifact.context.inputProjection,
              `tool ${tool.name} elicitation ${key} context`,
            ),
          }
        : {}),
    },
  ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** One projection shared by tools/list and the discovery manifest. */
export function projectMcpTool(name: string, tool: ListedTool): McpToolProjection {
  const elicits = projectElicits(tool);
  const requires = {
    ...(tool.capabilities.elicitation ? { elicitation: true } : {}),
    ...(tool.capabilities.sampling ? { sampling: true } : {}),
  };
  const hasRequires = Object.keys(requires).length > 0;
  return {
    name,
    description: tool.description,
    inputSchema: portableSchemaObject(
      tool.artifacts.parameters.inputProjection,
      `tool ${name} parameters`,
    ),
    ...(elicits || hasRequires
      ? {
          _meta: {
            "x-sweatpants": {
              ...(elicits ? { elicits } : {}),
              ...(hasRequires ? { requires } : {}),
            },
          },
        }
      : {}),
  };
}

export interface McpManifest {
  /** Schema version for the manifest */
  version: "1.0";

  /** Server metadata */
  server: {
    name: string;
    version: string;
    description?: string;
  };

  /** MCP endpoint configuration */
  mcp: {
    /** URL path to the MCP endpoint (relative to manifest location) */
    endpoint: string;
    /** Supported MCP protocol version */
    protocolVersion: string;
  };

  /** Tool definitions with x-sweatpants extensions */
  tools: Array<{
    name: string;
    description: string;
    inputSchema: JsonObject;
    _meta?: {
      "x-sweatpants"?: {
        elicits?: Record<string, McpElicitProjection>;
        requires?: {
          elicitation?: boolean;
          sampling?: boolean;
        };
      };
    };
  }>;
}

/**
 * Options for generating an MCP manifest.
 */
export interface GenerateMcpManifestOptions {
  /** Server name */
  name?: string;
  /** Server version */
  version?: string;
  /** Server description */
  description?: string;
  /** MCP endpoint path (default: '/mcp') */
  endpoint?: string;
}

/**
 * Generate an MCP manifest for /.well-known/mcp.json
 *
 * This enables service discovery and introspection of MCP tools,
 * including x-sweatpants extensions for elicit schemas.
 *
 * @example
 * ```typescript
 * import { generateMcpManifest } from '@sweatpants/tool-session/mcp'
 *
 * const tools = new Map([['book_flight', bookFlightTool]])
 *
 * const manifest = generateMcpManifest(tools, {
 *   name: 'Travel Agent',
 *   version: '1.0.0',
 *   description: 'Book flights and hotels',
 * })
 *
 * // Mount at /.well-known/mcp.json
 * app.get('/.well-known/mcp.json', () => Response.json(manifest))
 * ```
 */
export function generateMcpManifest(
  tools: ReadonlyMap<string, AnyToolContract>,
  options: GenerateMcpManifestOptions = {},
): McpManifest {
  const { name = "mcp-server", version = "1.0.0", description, endpoint = "/mcp" } = options;

  const toolList = Array.from(tools.entries()).map(([toolName, tool]) =>
    projectMcpTool(toolName, tool),
  );

  const manifest: McpManifest = {
    version: "1.0",
    server: {
      name,
      version,
      ...(description && { description }),
    },
    mcp: {
      endpoint,
      protocolVersion: MCP_PROTOCOL_VERSION,
    },
    tools: toolList,
  };

  return manifest;
}
