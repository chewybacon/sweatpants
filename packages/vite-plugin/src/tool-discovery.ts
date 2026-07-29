/**
 * Tool Discovery Vite Plugin
 *
 * Scans a directory for tool files and generates a type-safe registry.
 *
 * Features:
 * - File-based discovery (no manual imports)
 * - Watches for changes in dev mode
 * - Generates type-safe registry with const assertions
 * - Supports both default and named exports
 * - Derives tool names from export identifiers when no explicit name is given
 * - Build-time collision detection across files
 */
import type { Plugin } from "vite";
import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join, dirname, relative, posix, basename } from "path";
import fg from "fast-glob";
import { parse, traverse, transformFromAstSync, types as t } from "@babel/core";
import type {
  ToolDiscoveryOptions,
  ResolvedToolDiscoveryOptions,
  DiscoveredTool,
} from "./types.ts";
import { resolveToolDiscoveryOptions } from "./types.ts";

export function toolDiscoveryPlugin(userOptions: ToolDiscoveryOptions = {}): Plugin {
  const options = resolveToolDiscoveryOptions(userOptions);
  let root: string;
  // Track which files have been transformed (for duplicate detection in build mode)
  // Note: In dev mode (HMR), the same file may be transformed multiple times,
  // which is expected. We track by file+name to allow re-transforms of the same file.
  const transformedTools = new Map<string, string>(); // file -> toolName

  return {
    name: "@sweatpants/agent-host:tool-discovery",

    configResolved(config) {
      root = config.root;
    },

    async buildStart() {
      // Clear tracking on build start (fresh build)
      transformedTools.clear();
      await generateRegistry(root, options);
    },

    transform(code, id) {
      // Only transform files in the tools directory
      if (!id.startsWith(join(root, options.dir))) {
        return null;
      }

      // Only transform .ts and .tsx files
      if (!id.endsWith(".ts") && !id.endsWith(".tsx")) {
        return null;
      }

      try {
        const ast = parse(code, {
          filename: id,
          presets: ["@babel/preset-typescript"],
          sourceType: "module",
        });

        if (!ast) {
          return null;
        }

        let modified = false;
        const localBuilders = importedBuilderBindings(ast.program.body, options);

        traverse(ast, {
          CallExpression(path) {
            const { node } = path;

            // Recognize builders only through explicit import provenance.
            if (!t.isIdentifier(node.callee) || !localBuilders.has(node.callee.name)) {
              return;
            }

            // Case 1: explicit string name provided - leave it unchanged (no rewriting/prefixing).
            // Only record for cross-file collision detection.
            if (node.arguments.length > 0 && t.isStringLiteral(node.arguments[0])) {
              const finalName = node.arguments[0].value;
              const existingFile = transformedTools.get(finalName);
              if (existingFile && existingFile !== id) {
                throw new Error(
                  `Duplicate tool name detected: '${finalName}' (from ${id}, conflicts with ${existingFile})`,
                );
              }
              transformedTools.set(finalName, id);
              return;
            }

            // Case 2: no name argument - derive from export identifier and insert it.
            if (node.arguments.length === 0) {
              const exportName = findEnclosingExportName(path);
              const derivedName = exportName
                ? deriveNameFromExportName(exportName)
                : deriveNameFromFilePath(id);

              const existingFile = transformedTools.get(derivedName);
              if (existingFile && existingFile !== id) {
                throw new Error(
                  `Duplicate tool name detected: '${derivedName}' (from ${id}, conflicts with ${existingFile})`,
                );
              }
              transformedTools.set(derivedName, id);

              // Insert the derived name as the first argument
              node.arguments.push(t.stringLiteral(derivedName));
              modified = true;
            }
          },
        });

        if (modified) {
          // Generate code from AST
          const result = transformFromAstSync(ast, code, {
            filename: id,
            presets: ["@babel/preset-typescript"],
            sourceType: "module",
          });
          return result?.code || code;
        }
      } catch (error) {
        // If parsing fails, just return original code
        console.warn(`Failed to transform ${id}:`, error);
      }

      return null;
    },

    configureServer(server) {
      // Watch the tools directory for changes
      const toolsDir = join(root, options.dir);

      server.watcher.add(toolsDir);

      server.watcher.on("add", async (file) => {
        if (isToolFile(file, toolsDir, options)) {
          log(options, "normal", `[tool-discovery] New tool file: ${relative(root, file)}`);
          await generateRegistry(root, options);
        }
      });

      server.watcher.on("unlink", async (file) => {
        if (isToolFile(file, toolsDir, options)) {
          log(options, "normal", `[tool-discovery] Removed tool file: ${relative(root, file)}`);
          await generateRegistry(root, options);
        }
      });

      server.watcher.on("change", async (file) => {
        if (isToolFile(file, toolsDir, options)) {
          log(options, "verbose", `[tool-discovery] Changed tool file: ${relative(root, file)}`);
          await generateRegistry(root, options);
        }
      });
    },
  };
}

/**
 * Derive a tool name from an export identifier.
 *
 * Strips a trailing `Tool` suffix if present (e.g. `tictactoeTool` -> `tictactoe`).
 * Names without the suffix are returned unchanged.
 */
export function deriveNameFromExportName(exportName: string): string {
  if (exportName.endsWith("Tool") && exportName.length > "Tool".length) {
    return exportName.slice(0, -"Tool".length);
  }
  return exportName;
}

/**
 * Derive a tool name from a file path (used for default exports).
 *
 * Uses the file basename without extension (e.g. `my_tool.ts` -> `my_tool`).
 */
export function deriveNameFromFilePath(file: string): string {
  const fileBasename = basename(file).replace(/\.(ts|tsx)$/, "");
  return fileBasename;
}

/**
 * Climb the AST from a tool-builder CallExpression to find the enclosing
 * variable declarator id (named export) or detect a default export.
 *
 * Returns the export identifier name, or `null` for default exports (the
 * caller should fall back to the file name), or `undefined` if no enclosing
 * declarator was found.
 */
function findEnclosingExportName(path: { parentPath: any }): string | null | undefined {
  let p: any = path.parentPath;
  while (p) {
    if (t.isVariableDeclarator(p.node)) {
      if (t.isIdentifier(p.node.id)) {
        return p.node.id.name;
      }
      return undefined;
    }
    if (t.isExportDefaultDeclaration(p.node)) {
      return null;
    }
    p = p.parentPath;
  }
  return undefined;
}

function importedBuilderBindings(
  body: readonly t.Statement[],
  options: ResolvedToolDiscoveryOptions,
): Map<string, DiscoveredTool["execution"]> {
  const bindings = new Map<string, DiscoveredTool["execution"]>();
  for (const statement of body) {
    if (!t.isImportDeclaration(statement)) {
      continue;
    }
    const moduleName = statement.source.value;
    for (const specifier of statement.specifiers) {
      if (!t.isImportSpecifier(specifier)) {
        continue;
      }
      const importedName = t.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value;
      const configured = options.builders.find(
        (builder) =>
          (builder.module === "*" || builder.module === moduleName) &&
          builder.export === importedName,
      );
      if (configured) {
        bindings.set(specifier.local.name, configured.execution);
      }
    }
  }
  return bindings;
}

function importedBuilderNamesFromContent(
  content: string,
  options: ResolvedToolDiscoveryOptions,
): Map<string, DiscoveredTool["execution"]> {
  const bindings = new Map<string, DiscoveredTool["execution"]>();
  const imports = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = imports.exec(content)) !== null) {
    const group = match[1] ?? "";
    const moduleName = match[2] ?? "";
    for (const raw of group.split(",")) {
      const declaration = raw.trim().replace(/^type\s+/, "");
      if (!declaration) {
        continue;
      }
      const [imported, alias] = declaration.split(/\s+as\s+/).map((part) => part.trim());
      if (!imported) {
        continue;
      }
      const configured = options.builders.find(
        (builder) =>
          (builder.module === "*" || builder.module === moduleName) && builder.export === imported,
      );
      if (configured) {
        bindings.set(alias || imported, configured.execution);
      }
    }
  }
  return bindings;
}

function isToolFile(
  file: string,
  toolsDir: string,
  options: ResolvedToolDiscoveryOptions,
): boolean {
  if (!file.startsWith(toolsDir)) {
    return false;
  }
  const relPath = relative(toolsDir, file);

  // Check if it matches the pattern and is not ignored
  const isMatch = fg.isDynamicPattern(options.pattern)
    ? true // Let fast-glob handle it
    : relPath.endsWith(".ts") || relPath.endsWith(".tsx");

  const isIgnored = options.ignore.some((pattern) => {
    if (pattern.includes("*")) {
      return fg.isDynamicPattern(pattern) && relPath.includes(pattern.replace(/\*/g, ""));
    }
    return relPath.includes(pattern);
  });

  return isMatch && !isIgnored;
}

async function generateRegistry(
  root: string,
  options: ResolvedToolDiscoveryOptions,
): Promise<void> {
  const toolsDir = join(root, options.dir);
  const outFile = join(root, options.outFile);
  const workerOutFile = join(root, options.workerOutFile);

  // Check if tools directory exists
  try {
    await access(toolsDir);
  } catch {
    log(options, "verbose", `[tool-discovery] Tools directory not found: ${options.dir}`);
    // Generate empty registries
    await writeRegistryFile(outFile, [], options);
    await writeAgentCoreDurableRegistryFile(outFile, []);
    if (options.generateWorker) {
      await writeWorkerFile(workerOutFile, [], options);
    }
    return;
  }

  // Find all tool files
  const pattern = posix.join(options.dir, options.pattern);
  const files = await fg(pattern, {
    cwd: root,
    ignore: options.ignore.map((p) => posix.join(options.dir, p)),
    absolute: true,
  });

  if (files.length === 0) {
    log(options, "normal", `[tool-discovery] No tool files found in ${options.dir}`);
    await writeRegistryFile(outFile, [], options);
    await writeAgentCoreDurableRegistryFile(outFile, []);
    if (options.generateWorker) {
      await writeWorkerFile(workerOutFile, [], options);
    }
    return;
  }

  // Discover tools from each file
  const tools: DiscoveredTool[] = [];

  for (const file of files) {
    const discovered = await discoverToolsInFile(file, toolsDir, options);
    tools.push(...discovered);
  }

  log(options, "normal", `[tool-discovery] Found ${tools.length} tools in ${files.length} files`);

  // Detect duplicate tool names across files
  const seen = new Map<string, string>(); // toolName -> filePath
  for (const tool of tools) {
    const existing = seen.get(tool.toolName);
    if (existing) {
      throw new Error(
        `Duplicate tool name detected: '${tool.toolName}' (from ${tool.filePath}, conflicts with ${existing})`,
      );
    }
    seen.set(tool.toolName, tool.filePath);
  }

  // Generate registry
  await writeRegistryFile(outFile, tools, options);
  log(options, "normal", `[tool-discovery] Generated ${relative(root, outFile)}`);
  const agentCoreOutFile = await writeAgentCoreDurableRegistryFile(outFile, tools);
  log(options, "normal", `[tool-discovery] Generated ${relative(root, agentCoreOutFile)}`);

  if (options.generateWorker) {
    await writeWorkerFile(workerOutFile, tools, options);
    log(options, "normal", `[tool-discovery] Generated ${relative(root, workerOutFile)}`);
  }
}

async function discoverToolsInFile(
  file: string,
  toolsDir: string,
  options: ResolvedToolDiscoveryOptions,
): Promise<DiscoveredTool[]> {
  const content = await readFile(file, "utf-8");
  if (options.generateWorker) {
    assertWorkerCompatibleAuthoring(content, file, options);
  }
  return discoverToolsInContent(content, file, toolsDir, options);
}

/** Reject legacy ordinary-tool shapes before emitting a canonical worker. */
function assertWorkerCompatibleAuthoring(
  content: string,
  file: string,
  options: ResolvedToolDiscoveryOptions,
): void {
  const ast = parse(content, {
    filename: file,
    presets: ["@babel/preset-typescript"],
    sourceType: "module",
  });
  if (!ast) {
    return;
  }
  const builders = importedBuilderBindings(ast.program.body, options);
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (
        !t.isMemberExpression(callee) ||
        !t.isIdentifier(callee.property, { name: "build" }) ||
        callee.computed
      ) {
        return;
      }
      const root = builderRootIdentifier(callee.object);
      if (!root || builders.get(root) !== "ordinary") {
        return;
      }
      throw new Error(
        `Unsupported legacy worker tool in ${file}: ${root}(...).build() does not produce the canonical callable RuntimeTool required by generated workers. ` +
          `Migrate to ${root}(...).description(...).parameters(...).execute(...) or disable generateWorker for registry-only legacy discovery.`,
      );
    },
  });
}

function builderRootIdentifier(node: t.Node): string | undefined {
  if (!t.isCallExpression(node)) {
    return undefined;
  }
  if (t.isIdentifier(node.callee)) {
    return node.callee.name;
  }
  if (t.isMemberExpression(node.callee)) {
    return builderRootIdentifier(node.callee.object);
  }
  return undefined;
}

/**
 * Parse file content to discover tools.
 * Exported for testing - allows testing without file I/O.
 *
 * Tool names are derived as follows:
 * 1. If a string name argument is provided to the builder call, it is used as-is
 *    (no prefixing or rewriting).
 * 2. If no name argument is provided, the name is derived from the export
 *    identifier (stripping a trailing `Tool` suffix). For default exports
 *    without a variable name, the file basename (without extension) is used.
 */
export function discoverToolsInContent(
  content: string,
  file: string,
  toolsDir: string,
  options: ResolvedToolDiscoveryOptions,
): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];

  const localBuilders = importedBuilderNamesFromContent(content, options);
  const fnNames = [...localBuilders.keys()];
  if (fnNames.length === 0) {
    return [];
  }
  const fnPattern = fnNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  // Helper to compute the final tool name for a discovered call.
  // `explicitName` is the string arg when provided; `exportName` is the
  // enclosing identifier name (for derivation when no explicit name is given).
  const finalName = (explicitName: string | undefined, exportName: string | undefined): string => {
    if (explicitName !== undefined) {
      return explicitName;
    }
    if (exportName) {
      return deriveNameFromExportName(exportName);
    }
    return deriveNameFromFilePath(file);
  };

  let match: RegExpExecArray | null;

  // Named export with inline definition.
  // export const guessCard = createTool('guess_card')
  // export const guessCard = createTool()
  const namedExportRegex = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*(${fnPattern})\\s*\\(([^)]*)\\)`,
    "g",
  );

  while ((match = namedExportRegex.exec(content)) !== null) {
    const [, exportName, builderName, argBody] = match;
    if (!exportName || !builderName) {
      continue;
    }
    const explicitName = extractStringArg(argBody);
    const toolName = finalName(explicitName, exportName);
    tools.push({
      filePath: relative(toolsDir, file),
      absolutePath: file,
      exportName,
      toolName,
      execution: localBuilders.get(builderName) ?? "ordinary",
      variableName: exportName,
    });
  }

  // Default export with inline definition.
  // export default createTool('guess_card')
  // export default createTool()
  const defaultExportRegex = new RegExp(
    `export\\s+default\\s+(${fnPattern})\\s*\\(([^)]*)\\)`,
    "g",
  );

  while ((match = defaultExportRegex.exec(content)) !== null) {
    const [, builderName, argBody] = match;
    if (!builderName) {
      continue;
    }
    const explicitName = extractStringArg(argBody ?? "");
    const toolName = finalName(explicitName, undefined);
    tools.push({
      filePath: relative(toolsDir, file),
      absolutePath: file,
      toolName,
      execution: localBuilders.get(builderName) ?? "ordinary",
      variableName: toCamelCase(toolName),
    });
  }

  // Variable definition (not directly exported).
  // const guessCard = createTool('guess_card')
  // const guessCard = createTool()
  const varDefRegex = new RegExp(`const\\s+(\\w+)\\s*=\\s*(${fnPattern})\\s*\\(([^)]*)\\)`, "g");

  const varDefs = new Map<
    string,
    { explicitName: string | undefined; toolName: string; execution: DiscoveredTool["execution"] }
  >();
  while ((match = varDefRegex.exec(content)) !== null) {
    const [, varName, builderName, argBody] = match;
    if (!varName || !builderName) {
      continue;
    }
    const explicitName = extractStringArg(argBody ?? "");
    const toolName = finalName(explicitName, varName);
    varDefs.set(varName, {
      explicitName,
      toolName,
      execution: localBuilders.get(builderName) ?? "ordinary",
    });
  }

  // Check for default export of a variable
  const defaultExportVarRegex = /export\s+default\s+(\w+)\s*(?:;|\n|$)/g;
  while ((match = defaultExportVarRegex.exec(content)) !== null) {
    const [, varName] = match;
    if (!varName) {
      continue;
    }
    const def = varDefs.get(varName);
    if (def) {
      const alreadyAdded = tools.some((t) => t.toolName === def.toolName);
      if (!alreadyAdded) {
        tools.push({
          filePath: relative(toolsDir, file),
          absolutePath: file,
          toolName: def.toolName,
          execution: def.execution,
          variableName: varName,
        });
      }
    }
  }

  // Check for named exports of variables: export { foo } or export { foo as bar }
  const namedExportBraceRegex = /export\s*\{([^}]+)\}/g;
  while ((match = namedExportBraceRegex.exec(content)) !== null) {
    const exportGroup = match[1];
    if (!exportGroup) {
      continue;
    }
    const exports = exportGroup.split(",").map((s) => s.trim());
    for (const exp of exports) {
      // Handle 'foo' or 'foo as bar'
      const parts = exp.split(/\s+as\s+/);
      const rawVar = parts[0];
      if (!rawVar) {
        continue;
      }
      const varName = rawVar.trim();
      const exportName = parts[1]?.trim() ?? varName;
      if (!varName) {
        continue;
      }
      const def = varDefs.get(varName);
      if (def) {
        const alreadyAdded = tools.some((t) => t.toolName === def.toolName);
        if (!alreadyAdded) {
          tools.push({
            filePath: relative(toolsDir, file),
            absolutePath: file,
            exportName,
            toolName: def.toolName,
            execution: def.execution,
            variableName: exportName,
          });
        }
      }
    }
  }

  return tools;
}

/**
 * Extract the first string-literal argument from a call's argument body.
 * Returns `undefined` if the call has no string-literal first argument (e.g.
 * zero arguments, or a non-string first argument).
 */
function extractStringArg(argBody: string | undefined): string | undefined {
  const trimmed = (argBody ?? "").trim();
  if (trimmed === "") {
    return undefined;
  }
  const match = /^(['"`])([^'"`]+)\1/.exec(trimmed);
  return match?.[2] ?? undefined;
}

async function writeRegistryFile(
  outFile: string,
  tools: DiscoveredTool[],
  options: ResolvedToolDiscoveryOptions,
): Promise<void> {
  // Ensure output directory exists
  const outDir = dirname(outFile);
  await mkdir(outDir, { recursive: true });

  const content = generateRegistryContent(tools, outFile, options);
  await writeFile(outFile, content);
}

async function writeAgentCoreDurableRegistryFile(
  registryOutFile: string,
  tools: DiscoveredTool[],
): Promise<string> {
  const outFile = join(dirname(registryOutFile), "agentcore-durable-program-registry.gen.ts");
  await mkdir(dirname(outFile), { recursive: true });
  const durableTools = tools
    .filter((tool) => tool.execution === "crank_native")
    .sort((left, right) => left.toolName.localeCompare(right.toolName));
  const imports = durableTools.map((tool) => {
    const importPath = calculateImportPath(outFile, tool.absolutePath);
    return tool.exportName
      ? `import { ${tool.exportName} } from '${importPath}'`
      : `import ${tool.variableName} from '${importPath}'`;
  });
  const entries = durableTools.map((tool) => `  '${tool.toolName}': ${tool.variableName},`);
  const content = `/**
 * Exact AgentCore durable-program registry (auto-generated).
 *
 * DO NOT EDIT. This artifact intentionally imports no ordinary ToolSession tool.
 */
${imports.join("\n")}

export const agentCoreDurableDefinitions = {
${entries.join("\n")}
} as const

export const agentCoreDurablePrograms = new Map(
  Object.values(agentCoreDurableDefinitions).map((tool) => [
    \`${"${tool.manifest.programId}"}@${"${tool.manifest.version}"}#${"${tool.manifest.digest}"}\`,
    tool,
  ] as const)
)

export const agentCoreDurableProgramCatalog = Object.values(agentCoreDurableDefinitions).map((tool) => ({
  publicName: tool.name,
  program: {
    id: tool.manifest.programId,
    version: tool.manifest.version,
    digest: tool.manifest.digest,
  },
}))
`;
  await writeFile(outFile, content);
  return outFile;
}

async function writeWorkerFile(
  outFile: string,
  tools: DiscoveredTool[],
  options: ResolvedToolDiscoveryOptions,
): Promise<void> {
  const outDir = dirname(outFile);
  await mkdir(outDir, { recursive: true });

  const content = generateWorkerContent(tools, outFile, options);
  await writeFile(outFile, content);

  // Note: Worker bundling is now handled by vite-plugin-node-worker.
  // Import the generated file with ?modulePath suffix to get a bundled worker URL.
  // Example: import workerUrl from './tool-worker.gen.ts?modulePath'
}

/**
 * Generate registry file content.
 * Exported for testing - allows testing output format without file I/O.
 */
export function generateRegistryContent(
  tools: DiscoveredTool[],
  outFile: string,
  options: ResolvedToolDiscoveryOptions,
): string {
  // Generate imports and registry
  const imports: string[] = [];
  const registryEntries: string[] = [];
  const ordinaryEntries: string[] = [];
  const durableEntries: string[] = [];
  const typeEntries: string[] = [];

  // Sort tools for deterministic output
  const sortedTools = [...tools].sort((a, b) => a.toolName.localeCompare(b.toolName));

  for (const tool of sortedTools) {
    // Calculate relative import path from output file to tool file
    const importPath = calculateImportPath(outFile, tool.absolutePath);

    if (tool.exportName) {
      imports.push(`import { ${tool.exportName} } from '${importPath}'`);
    } else {
      imports.push(`import ${tool.variableName} from '${importPath}'`);
    }

    registryEntries.push(`  ${tool.variableName},`);
    if (tool.execution === "crank_native") {
      durableEntries.push(`  '${tool.toolName}': ${tool.variableName},`);
    } else {
      ordinaryEntries.push(`  '${tool.toolName}': ${tool.variableName},`);
    }
    typeEntries.push(`  | '${tool.toolName}'`);
  }

  return `/**
 * Tool Registry (auto-generated)
 *
 * DO NOT EDIT - This file is generated by @sweatpants/agent-host
 * Regenerate by modifying files in ${options.dir}/
 */

${imports.join("\n")}

/**
 * All discovered tools as a const object.
 * Use this for type-safe tool access.
 */
export const tools = {
${registryEntries.join("\n")}
} as const

/**
 * Array of all tools (for runtime iteration).
 */
export const toolList = Object.values(tools)

/** Ordinary executable definitions only; safe for ToolSession/worker routing. */
export const ordinaryTools = {
${ordinaryEntries.join("\n")}
} as const

/** Crank-native definitions only; consumed by host ProgramDriver placement. */
export const durablePrograms = {
${durableEntries.join("\n")}
} as const

/**
 * Exact AgentCore evaluator registry, deliberately separate from ordinary
 * ToolSession worker output. Runtime images look up only id@version#digest.
 */
export const agentCoreDurablePrograms = new Map(
  Object.values(durablePrograms).map((tool) => [
    \`${"${tool.manifest.programId}"}@${"${tool.manifest.version}"}#${"${tool.manifest.digest}"}\`,
    tool,
  ] as const)
)

/** Immutable deployment catalog used by release readiness reconciliation. */
export const agentCoreDurableProgramCatalog = Object.values(durablePrograms).map((tool) => ({
  publicName: tool.name,
  program: {
    id: tool.manifest.programId,
    version: tool.manifest.version,
    digest: tool.manifest.digest,
  },
}))

/** Digest-keyed runtime validators reachable from generated contracts. */
export const validatorCatalog = toolList.flatMap((tool) =>
  'artifacts' in tool ? [...tool.artifacts.catalog] : []
)

/** Versioned catalogs published beside each exact crank-native definition. */
export const durableValidatorCatalogs = Object.fromEntries(
  Object.entries(durablePrograms).map(([name, tool]) => [
    name,
    {
      program: {
        id: tool.manifest.programId,
        version: tool.manifest.version,
        digest: tool.manifest.digest,
      },
      entries: [...tool.artifacts.catalog],
    },
  ])
)

/**
 * Union type of all tool names.
 */
export type ToolName =
${typeEntries.length > 0 ? typeEntries.join("\n") : "  never"}

/**
 * Get a tool by name (type-safe).
 */
export function getTool<T extends ToolName>(name: T) {
  return toolList.find((t) => t.name === name)
}

/**
 * Type helper: Extract the tool type by name.
 */
export type ToolByName<T extends ToolName> = (typeof tools)[keyof typeof tools] & { name: T }
`;
}

/**
 * Generate worker entry file content.
 */
export function generateWorkerContent(
  tools: DiscoveredTool[],
  outFile: string,
  _options: ResolvedToolDiscoveryOptions,
): string {
  const imports: string[] = [];
  const registryEntries: string[] = [];

  // Worker files run as raw Node.js ESM with --experimental-strip-types,
  // which supports .ts but NOT .tsx (JSX requires transformation).
  // Skip .tsx files because raw Node.js workers do not transform JSX.
  const workerCompatibleTools = tools.filter(
    (tool) => tool.execution === "ordinary" && !tool.absolutePath.endsWith(".tsx"),
  );
  const sortedTools = [...workerCompatibleTools].sort((a, b) =>
    a.toolName.localeCompare(b.toolName),
  );

  for (const tool of sortedTools) {
    // Worker files run as raw Node.js ESM (not through Vite), so they need
    // explicit .ts extensions for module resolution
    const importPath = calculateWorkerImportPath(outFile, tool.absolutePath);
    const variableName = tool.exportName ?? tool.variableName;
    const importStatement = tool.exportName
      ? `import { ${tool.exportName} } from '${importPath}'`
      : `import ${tool.variableName} from '${importPath}'`;

    imports.push(importStatement);
    registryEntries.push(`  ${variableName}`);
  }

  return `/**
 * Tool Worker Entry (auto-generated)
 *
 * DO NOT EDIT - This file is generated by @sweatpants/agent-host
 */
import { runToolWorkerEntry } from '@sweatpants/tool-runtime-local/worker'

${imports.join("\n")}

await runToolWorkerEntry([
${registryEntries.length > 0 ? registryEntries.join(",\n") : ""}
])
`;
}

// Exported for testing
export function calculateImportPath(from: string, to: string): string {
  let rel = relative(dirname(from), to);

  // Ensure it starts with ./ or ../
  if (!rel.startsWith(".") && !rel.startsWith("/")) {
    rel = "./" + rel;
  }

  // Remove .ts extension for import
  rel = rel.replace(/\.tsx?$/, "");

  // Normalize to posix paths
  rel = rel.split("\\").join("/");

  return rel;
}

/**
 * Calculate import path for worker files.
 * Unlike calculateImportPath, this PRESERVES .ts extensions because
 * worker threads run as raw Node.js ESM (not through Vite) and require
 * explicit file extensions for module resolution.
 */
export function calculateWorkerImportPath(from: string, to: string): string {
  let rel = relative(dirname(from), to);

  // Ensure it starts with ./ or ../
  if (!rel.startsWith(".") && !rel.startsWith("/")) {
    rel = "./" + rel;
  }

  // Normalize to posix paths
  rel = rel.split("\\").join("/");

  return rel;
}

// Exported for testing
export function toCamelCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function log(
  options: ResolvedToolDiscoveryOptions,
  level: "verbose" | "normal",
  message: string,
): void {
  if (options.logLevel === "silent") {
    return;
  }
  if (level === "verbose" && options.logLevel !== "verbose") {
    return;
  }
  console.log(message);
}
