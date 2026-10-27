/**
 * Types for the framework Vite plugins.
 */

export type DiscoveredToolExecution = "ordinary" | "crank_native" | "journal";

/** Import provenance and execution kind of one supported tool builder. */
export interface ToolBuilderDiscoveryConfig {
  readonly module: string;
  readonly export: string;
  readonly execution: DiscoveredToolExecution;
}

export interface ToolDiscoveryOptions {
  /**
   * Directory to scan for tools, relative to project root.
   * @default 'src/tools'
   */
  dir?: string;

  /**
   * Output file for the generated registry, relative to project root.
   * @default 'src/__generated__/tool-registry.gen.ts'
   */
  outFile?: string;

  /**
   * Glob pattern for tool files within the dir.
   * @default '**\/*.ts'
   */
  pattern?: string;

  /**
   * Files/patterns to ignore.
   * @default ['**\/*.test.ts', '**\/*.test.tsx', '**\/*.spec.ts', '**\/*.spec.tsx', '**\/__tests__/**']
   */
  ignore?: string[];

  /**
   * Function name(s) to look for in exports.
   * @default ['createTool']
   */
  exportFunctionName?: string | string[];

  /**
   * Import-aware builder provenance. Aliases are resolved against these
   * module/export pairs instead of classifying bare callee text.
   * @default createTool + createDurableTool from @sweatpants/agent-sdk
   */
  builders?: ToolBuilderDiscoveryConfig[];

  /**
   * Log level for the plugin.
   * @default 'normal'
   */
  logLevel?: "silent" | "normal" | "verbose";

  /**
   * Generate a worker entry file for tool execution.
   * @default false
   */
  generateWorker?: boolean;

  /**
   * Output file for the generated worker entry, relative to project root.
   * @default 'src/__generated__/tool-worker.gen.ts'
   */
  workerOutFile?: string;
}

export interface ResolvedToolDiscoveryOptions {
  dir: string;
  outFile: string;
  pattern: string;
  ignore: string[];
  exportFunctionName: string[];
  builders: ToolBuilderDiscoveryConfig[];
  logLevel: "silent" | "normal" | "verbose";
  generateWorker: boolean;
  workerOutFile: string;
}

export function resolveToolDiscoveryOptions(
  options: ToolDiscoveryOptions = {},
): ResolvedToolDiscoveryOptions {
  const exportFunctionName = options.exportFunctionName ?? ["createTool"];
  const builders =
    options.builders ??
    (options.exportFunctionName !== undefined
      ? (Array.isArray(exportFunctionName) ? exportFunctionName : [exportFunctionName]).map(
          (name) => ({ module: "*", export: name, execution: "ordinary" as const }),
        )
      : [
          { module: "@sweatpants/agent-sdk", export: "createTool", execution: "ordinary" as const },
          {
            module: "@sweatpants/agent-sdk",
            export: "createDurableTool",
            execution: "journal" as const,
          },
          {
            module: "@sweatpants/agent-sdk/legacy",
            export: "createDurableTool",
            execution: "crank_native" as const,
          },
        ]);

  return {
    dir: options.dir ?? "src/tools",
    outFile: options.outFile ?? "src/__generated__/tool-registry.gen.ts",
    pattern: options.pattern ?? "**/*.ts",
    ignore: options.ignore ?? [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/__tests__/**",
    ],
    exportFunctionName: Array.isArray(exportFunctionName)
      ? exportFunctionName
      : [exportFunctionName],
    builders,
    logLevel: options.logLevel ?? "normal",
    generateWorker: options.generateWorker ?? false,
    workerOutFile: options.workerOutFile ?? "src/__generated__/tool-worker.gen.ts",
  };
}

export interface DiscoveredTool {
  /**
   * The file path relative to the tools directory.
   */
  filePath: string;

  /**
   * The absolute file path.
   */
  absolutePath: string;

  /**
   * The export name (e.g., 'guessCard' for `export const guessCard = ...`).
   * Undefined if it's a default export.
   */
  exportName?: string;

  /**
   * The final tool name. This is either the explicit name passed to the
   * builder call, or a name derived from the export identifier (with a
   * trailing `Tool` suffix stripped) / file basename for default exports.
   */
  toolName: string;

  /** Execution kind resolved from import provenance. */
  execution: DiscoveredToolExecution;

  /**
   * Variable name to use in the registry (camelCase of toolName or exportName).
   */
  variableName: string;
}
