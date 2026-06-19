// Narrow shim for AgentCore-bundled app tools that import
// `createMcpTool` from the public `@sweatpants/framework/chat` subpath.
//
// The full chat barrel also exports providers/logger/client utilities. Bundling
// that whole barrel into the ESM AgentCore runtime pulls in pino's CommonJS
// dynamic requires. App tools only need the MCP builder at runtime, so this shim
// keeps the AgentCore bundle minimal and ESM-safe.
export { createMcpTool } from '../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-builder.ts'
export type { ExtendedMessage } from '../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts'
