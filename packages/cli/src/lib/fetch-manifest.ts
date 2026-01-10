/**
 * Fetch MCP Manifest
 * 
 * Utilities for fetching and parsing MCP manifests from URLs or files.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/**
 * MCP Manifest structure (matches the server's generateMcpManifest output)
 */
export interface McpManifest {
  version: string
  server: {
    name: string
    version: string
    description?: string
  }
  mcp: {
    endpoint: string
    protocolVersion: string
  }
  tools: McpToolDefinition[]
}

/**
 * Tool definition with x-sweatpants extension
 */
export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  _meta?: {
    'x-sweatpants'?: {
      elicits?: Record<string, {
        response: Record<string, unknown>
        context?: Record<string, unknown>
      }>
      requires?: {
        elicitation?: boolean
        sampling?: boolean
      }
    }
  }
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
  if (existsSync(input) || input.startsWith('./') || input.startsWith('/')) {
    return fetchFromFile(input)
  }

  // Treat as URL
  return fetchFromUrl(input)
}

/**
 * Fetch manifest from a local file.
 */
async function fetchFromFile(filePath: string): Promise<McpManifest> {
  const content = await readFile(filePath, 'utf-8')
  
  try {
    const manifest = JSON.parse(content) as McpManifest
    validateManifest(manifest)
    return manifest
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in manifest file: ${filePath}`)
    }
    throw error
  }
}

/**
 * Fetch manifest from a URL.
 */
async function fetchFromUrl(input: string): Promise<McpManifest> {
  let url = input
  
  // Normalize URL
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `http://${url}`
  }
  
  // Append well-known path if not present
  if (!url.includes('/.well-known/mcp.json')) {
    url = url.replace(/\/$/, '') + '/.well-known/mcp.json'
  }

  const response = await fetch(url)
  
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest from ${url}: ${response.status} ${response.statusText}`)
  }

  const manifest = await response.json() as McpManifest
  validateManifest(manifest)
  return manifest
}

/**
 * Validate that a manifest has the required structure.
 */
function validateManifest(manifest: unknown): asserts manifest is McpManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest must be an object')
  }

  const m = manifest as Record<string, unknown>
  
  if (!m['tools'] || !Array.isArray(m['tools'])) {
    throw new Error('Manifest must have a tools array')
  }

  for (const tool of m['tools'] as unknown[]) {
    if (!tool || typeof tool !== 'object') {
      throw new Error('Each tool must be an object')
    }
    
    const t = tool as Record<string, unknown>
    if (typeof t['name'] !== 'string') {
      throw new Error('Each tool must have a name')
    }
  }
}
