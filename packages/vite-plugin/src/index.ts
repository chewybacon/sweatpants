/**
 * @sweatpants/agent-host Vite Plugin
 *
 * Provides file-based discovery and registry generation for:
 * - Canonical core tools
 * - Providers (future)
 * - Personas (future)
 * - Rendering pipelines (future)
 *
 * Inspired by TanStack Start's approach to type-safe, low-ceremony APIs.
 */
import type { Plugin } from "vite";
import { workflowPlugin } from "./workflow.ts";
export { workflowPlugin };
import { toolDiscoveryPlugin } from "./tool-discovery.ts";
import { clientContractPlugin } from "./client-contract-compiler.ts";
import type { ToolDiscoveryOptions } from "./types.ts";

export type { ToolDiscoveryOptions };
export { toolDiscoveryPlugin, clientContractPlugin };
export {
  analyzeClientContractSource,
  generateClientContractModule,
  ClientContractCompilerError,
  CLIENT_CONTRACT_QUERY,
} from "./client-contract-compiler.ts";
export type {
  ClientContractAnalysis,
  ClientContractDiagnosticCode,
} from "./client-contract-compiler.ts";
export { nodeWorkerPlugin } from "./node-worker-plugin.ts";

// Test utilities - exported for testing discovery logic without file I/O
export {
  discoverToolsInContent,
  generateRegistryContent,
  generateWorkerContent,
  calculateImportPath,
  calculateWorkerImportPath,
  toCamelCase,
  deriveNameFromExportName,
  deriveNameFromFilePath,
} from "./tool-discovery.ts";

export { resolveToolDiscoveryOptions } from "./types.ts";
export type { DiscoveredTool, ResolvedToolDiscoveryOptions } from "./types.ts";

export interface FrameworkOptions {
  /**
   * Tool discovery options.
   * Set to false to disable tool discovery.
   */
  tools?: ToolDiscoveryOptions | false;
}

/**
 * Main framework plugin that composes all sub-plugins.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { frameworkPlugin } from '@sweatpants/vite-plugin'
 *
 * export default defineConfig({
 *   plugins: [
 *     frameworkPlugin({
 *       tools: {
 *         dir: 'src/tools',
 *         outFile: 'src/__generated__/tool-registry.gen.ts',
 *       },
 *     }),
 *   ],
 * })
 * ```
 */
export function frameworkPlugin(options: FrameworkOptions = {}): Plugin[] {
  const plugins: Plugin[] = [];

  if (options.tools !== false) {
    plugins.push(toolDiscoveryPlugin(options.tools));
  }
  plugins.push(clientContractPlugin(), workflowPlugin());

  return plugins;
}

export default frameworkPlugin;

export { workflowArtifactPlugin } from "./workflow-artifacts.js";
