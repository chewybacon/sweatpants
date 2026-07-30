/**
 * Fetch MCP Manifest
 *
 * Utilities for fetching and parsing MCP manifests from URLs or files.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * MCP Manifest structure (matches the server's generateMcpManifest output)
 */
export interface McpManifest {
  version: string;
  server: {
    name: string;
    version: string;
    description?: string;
  };
  mcp: {
    endpoint: string;
    protocolVersion: string;
  };
  tools: McpToolDefinition[];
}

/**
 * Tool definition with x-sweatpants extension
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: {
    "x-sweatpants"?: {
      elicits?: Record<
        string,
        {
          response: Record<string, unknown>;
          context?: Record<string, unknown>;
        }
      >;
      requires?: {
        elicitation?: boolean;
        sampling?: boolean;
      };
    };
  };
}

/**
 * Fetch manifest from a URL or file path.
 *
 * If input is a URL:
 * - Appends /.well-known/mcp.json if not already present
 * - Fetches via HTTP/HTTPS
 *
 * If input is a file path:
 * - Reads from local filesystem
 */
export async function fetchManifest(input: string): Promise<McpManifest> {
  // Check if it's a file path
  if (existsSync(input) || input.startsWith("./") || input.startsWith("/")) {
    return fetchFromFile(input);
  }

  // Treat as URL
  return fetchFromUrl(input);
}

/**
 * Fetch manifest from a local file.
 */
async function fetchFromFile(filePath: string): Promise<McpManifest> {
  const content = await readFile(filePath, "utf-8");

  try {
    return parseMcpManifest(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in manifest file: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Fetch manifest from a URL.
 */
async function fetchFromUrl(input: string): Promise<McpManifest> {
  let url = input;

  // Normalize URL
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `http://${url}`;
  }

  // Append well-known path if not present
  if (!url.includes("/.well-known/mcp.json")) {
    url = url.replace(/\/$/, "") + "/.well-known/mcp.json";
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch manifest from ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return parseMcpManifest(await response.json());
}

const jsonSchema = z.record(z.string(), z.json());
const manifestSchema = z
  .object({
    version: z.string().min(1).max(64),
    server: z
      .object({
        name: z.string().min(1).max(512),
        version: z.string().min(1).max(128),
        description: z.string().max(16_384).optional(),
      })
      .strict(),
    mcp: z
      .object({
        endpoint: z.string().min(1).max(2_048),
        protocolVersion: z.string().min(1).max(128),
      })
      .strict(),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(512),
            description: z.string().max(16_384),
            inputSchema: jsonSchema,
            _meta: z
              .object({
                "x-sweatpants": z
                  .object({
                    elicits: z
                      .record(
                        z.string().min(1).max(512),
                        z
                          .object({
                            response: jsonSchema,
                            context: jsonSchema.optional(),
                          })
                          .strict(),
                      )
                      .optional(),
                    requires: z
                      .object({
                        elicitation: z.boolean().optional(),
                        sampling: z.boolean().optional(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(1_024),
  })
  .strict();

/** Parses the complete current MCP manifest shape from an untrusted value. */
export function parseMcpManifest(value: unknown): McpManifest {
  try {
    return manifestSchema.parse(value) as unknown as McpManifest;
  } catch {
    throw new Error("MCP manifest has an invalid closed shape");
  }
}
