import { fromByteArray, toByteArray } from "base64-js";
import { z } from "zod";
import type { JsonObject } from "@sweatpants/foundation";

const metadataSchema = z.object({
  "io.modelcontextprotocol/logLevel": z
    .enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"])
    .optional(),
  "io.modelcontextprotocol/protocolVersion": z.string().min(1),
  "io.modelcontextprotocol/clientCapabilities": z.record(z.string(), z.unknown()),
  "io.modelcontextprotocol/clientInfo": z
    .object({ name: z.string(), version: z.string() })
    .optional(),
});

/** Protocol errors are separate from authenticated caller identity and tool errors. */
export class McpRequestMetadataError extends Error {
  readonly status = 400;
  constructor(
    readonly code: -32600 | -32020 | -32021 | -32022,
    message: string,
    readonly data?: JsonObject,
  ) {
    super(message);
    this.name = "McpRequestMetadataError";
  }
}

function mismatch(message: string): never {
  throw new McpRequestMetadataError(-32020, message);
}

/** MCP's UTF-8 Base64 sentinel, not RFC 2047 or URL encoding. */
export function encodeMcpHeaderValue(value: string): string {
  if (
    /^[\x20-\x7e\t]*$/.test(value) &&
    value.trim() === value &&
    !(value.startsWith("=?base64?") && value.endsWith("?="))
  ) {
    return value;
  }
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${fromByteArray(bytes)}?=`;
}

function decodeHeader(value: string): string {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) {
    if (!/^[\x20-\x7e\t]*$/.test(value) || value.trim() !== value) {
      mismatch("Invalid MCP header value");
    }
    return value;
  }
  const encoded = value.slice(9, -2);
  try {
    const bytes = toByteArray(encoded);
    if (fromByteArray(bytes) !== encoded) {
      return mismatch("Invalid MCP Base64 header");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return mismatch("Invalid MCP Base64 header");
  }
}

/** Validate each request independently. Never infer capabilities from an earlier request. */
export function readMcpRequestMetadata(input: {
  readonly headers: Headers;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly protocolVersion: string;
}) {
  const metadata = metadataSchema.safeParse(input.params._meta);
  if (!metadata.success) {
    throw new McpRequestMetadataError(
      -32600,
      "Required MCP request metadata is missing or malformed",
    );
  }
  const requested = metadata.data["io.modelcontextprotocol/protocolVersion"];
  if (input.headers.get("MCP-Protocol-Version") !== requested) {
    mismatch("MCP-Protocol-Version does not match request metadata");
  }
  if (input.headers.get("Mcp-Method") !== input.method) {
    mismatch("Mcp-Method does not match request method");
  }
  if (requested !== input.protocolVersion) {
    throw new McpRequestMetadataError(-32022, "Unsupported protocol version", {
      requested,
      supported: [input.protocolVersion],
    });
  }
  const name = input.method === "resources/read" ? input.params.uri : input.params.name;
  if (["tools/call", "resources/read", "prompts/get"].includes(input.method)) {
    const header = input.headers.get("Mcp-Name");
    if (typeof name !== "string" || header === null || decodeHeader(header) !== name) {
      mismatch("Mcp-Name does not match request target");
    }
  }
  return {
    protocolVersion: requested,
    logLevel: metadata.data["io.modelcontextprotocol/logLevel"],
    clientInfo: metadata.data["io.modelcontextprotocol/clientInfo"],
    capabilities: metadata.data["io.modelcontextprotocol/clientCapabilities"],
  };
}

/** Form support is implicit when elicitation is declared without either mode. */
export function requireMcpFormCapability(capabilities: Readonly<Record<string, unknown>>): void {
  const elicitation = z
    .object({ form: z.object({}).optional(), url: z.object({}).optional() })
    .safeParse(capabilities.elicitation);
  if (
    elicitation.success &&
    (elicitation.data.form !== undefined || elicitation.data.url === undefined)
  ) {
    return;
  }
  throw new McpRequestMetadataError(-32021, "Client does not support form elicitation", {
    requiredCapabilities: { elicitation: { form: {} } },
  });
}

export interface McpParameterHeader {
  readonly name: string;
  readonly path: readonly string[];
  readonly type: "string" | "integer" | "boolean";
}

/** Compile schema annotations once, so invalid definitions never reach discovery. */
export function compileMcpParameterHeaders(schema: unknown): readonly McpParameterHeader[] {
  const result: McpParameterHeader[] = [];
  const names = new Set<string>();
  function visit(value: unknown, path: string[], reachable: boolean): void {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, path, false);
      }
      return;
    }
    const node = value as Record<string, unknown>;
    if (Object.hasOwn(node, "x-mcp-header")) {
      const name = node["x-mcp-header"];
      const type = node.type;
      if (
        !reachable ||
        path.length === 0 ||
        typeof name !== "string" ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        names.has(name.toLowerCase()) ||
        (type !== "string" && type !== "integer" && type !== "boolean")
      ) {
        throw new Error("Invalid x-mcp-header annotation");
      }
      names.add(name.toLowerCase());
      result.push({ name: `Mcp-Param-${name}`, path, type });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [property, nested] of Object.entries(child)) {
          visit(nested, [...path, property], reachable && !node.$ref);
        }
      } else if (
        [
          "items",
          "prefixItems",
          "contains",
          "additionalProperties",
          "unevaluatedProperties",
          "propertyNames",
          "not",
          "if",
          "then",
          "else",
          "oneOf",
          "anyOf",
          "allOf",
          "$defs",
          "definitions",
          "patternProperties",
          "dependentSchemas",
        ].includes(key)
      ) {
        visit(child, path, false);
        if (child && typeof child === "object" && !Array.isArray(child)) {
          for (const nested of Object.values(child)) {
            visit(nested, path, false);
          }
        }
      }
    }
  }
  visit(schema, [], true);
  return result;
}

export function validateMcpParameterHeaders(
  headers: Headers,
  args: unknown,
  annotations: readonly McpParameterHeader[],
): void {
  for (const annotation of annotations) {
    let value: unknown = args;
    for (const key of annotation.path) {
      value =
        value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined;
    }
    const header = headers.get(annotation.name);
    if (value === undefined) {
      if (header !== null) {
        mismatch(`Unexpected ${annotation.name}`);
      }
      continue;
    }
    const valid =
      annotation.type === "integer"
        ? Number.isSafeInteger(value)
        : typeof value === annotation.type;
    if (!valid || header === null || decodeHeader(header) !== String(value)) {
      mismatch(`${annotation.name} does not match tool arguments`);
    }
  }
}
