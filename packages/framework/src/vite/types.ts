/**
 * Types for the framework Vite plugins.
 */

export interface ToolDiscoveryOptions {
  /**
   * Directory to scan for tools, relative to project root.
   * @default 'src/tools'
   */
  dir?: string

  /**
   * Output file for the generated registry, relative to project root.
   * @default 'src/__generated__/tool-registry.gen.ts'
   */
  outFile?: string

  /**
   * Glob pattern for tool files within the dir.
   * @default '**\/*.ts'
   */
  pattern?: string

  /**
   * Files/patterns to ignore.
   * @default ['**\/*.test.ts', '**\/*.test.tsx', '**\/*.spec.ts', '**\/*.spec.tsx', '**\/__tests__/**']
   */
  ignore?: string[]

  /**
   * Function name(s) to look for in exports.
   * @default ['createIsomorphicTool', 'createMcpTool']
   */
  exportFunctionName?: string | string[]

  /**
   * Log level for the plugin.
   * @default 'normal'
   */
  logLevel?: 'silent' | 'normal' | 'verbose'

  /**
   * Generate a worker entry file for tool execution.
   * @default false
   */
  generateWorker?: boolean

  /**
   * Output file for the generated worker entry, relative to project root.
   * @default 'src/__generated__/tool-worker.gen.ts'
   */
  workerOutFile?: string
}

export interface ResolvedToolDiscoveryOptions {
  dir: string
  outFile: string
  pattern: string
  ignore: string[]
  exportFunctionName: string[]
  logLevel: 'silent' | 'normal' | 'verbose'
  generateWorker: boolean
  workerOutFile: string
}

export function resolveToolDiscoveryOptions(
  options: ToolDiscoveryOptions = {}
): ResolvedToolDiscoveryOptions {
  const exportFunctionName = options.exportFunctionName ?? [
    'createIsomorphicTool',
    'createMcpTool',
  ]

  return {
    dir: options.dir ?? 'src/tools',
    outFile: options.outFile ?? 'src/__generated__/tool-registry.gen.ts',
    pattern: options.pattern ?? '**/*.ts',
    ignore: options.ignore ?? ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/__tests__/**'],
    exportFunctionName: Array.isArray(exportFunctionName)
      ? exportFunctionName
      : [exportFunctionName],
    logLevel: options.logLevel ?? 'normal',
    generateWorker: options.generateWorker ?? false,
    workerOutFile: options.workerOutFile ?? 'src/__generated__/tool-worker.gen.ts',
  }
}

export interface DiscoveredTool {
  /**
   * The file path relative to the tools directory.
   */
  filePath: string

  /**
   * The absolute file path.
   */
  absolutePath: string

  /**
   * The export name (e.g., 'guessCard' for `export const guessCard = ...`).
   * Undefined if it's a default export.
   */
  exportName?: string

  /**
   * The tool name extracted from createIsomorphicTool('tool_name').
   */
  toolName: string

  /**
   * Variable name to use in the registry (camelCase of toolName or exportName).
   */
  variableName: string
}
