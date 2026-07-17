import {
  canonicalJson,
  generateProgramArtifactIdentity,
  sha256,
  type GeneratedProgramArtifactIdentityV1,
  type ProgramArtifactIdentityInputV1,
} from "@sweatpants/session-contract";

import {
  binaryResource,
  defineResourcePackage,
  encodeResourceBase64,
  jsonResource,
  textResource,
  type DefineResourcePackageOptions,
} from "./package.ts";
import {
  ResourceError,
  sortedResourceValues,
  type ResourceLimits,
  type ResourcePackage,
} from "./types.ts";

export const RESOURCE_COMPILER_VERSION = 1;

type DirectoryEntry = {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};
type FileStat = { isDirectory(): boolean; isSymbolicLink(): boolean };
type FsPromisesPort = {
  readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  lstat(path: string): Promise<FileStat>;
};
type PathPort = { join(...parts: string[]): string; dirname(path: string): string };
type WatchPort = {
  watch(path: string, options: { recursive: true }, listener: () => void): { close(): void };
};

async function loadNodeModule(specifier: string): Promise<unknown> {
  const runtime = (
    globalThis as typeof globalThis & {
      process?: { getBuiltinModule?: (name: string) => unknown };
    }
  ).process?.getBuiltinModule;
  if (!runtime) {
    throw new ResourceError(
      "invalid_resource_manifest",
      "Resource generation requires a supported Node.js runtime",
    );
  }
  return runtime(specifier);
}

export interface ResourceDirectoryCompilerOptions {
  readonly root: string;
  readonly id: string;
  readonly version: string;
  readonly include?: readonly string[];
  readonly ignore?: readonly string[];
  readonly text?: readonly string[];
  readonly json?: readonly string[];
  readonly mediaTypes?: Readonly<Record<string, string>>;
  readonly limits?: Partial<ResourceLimits>;
  readonly mode?: "memory" | "write" | "verify";
  readonly outputFile?: string;
}

export interface CompiledResourceDirectory {
  readonly package: ResourcePackage;
  readonly compilerVersion: number;
  readonly configDigest: string;
  readonly generatedSource: string;
}

/** Build-time-only directory compiler. Runtime package reads never retain the source root. */
export async function compileResourceDirectory(
  options: ResourceDirectoryCompilerOptions,
): Promise<CompiledResourceDirectory> {
  const fs = (await loadNodeModule("node:fs/promises")) as FsPromisesPort;
  const pathApi = (await loadNodeModule("node:path")) as PathPort;
  const include = options.include ?? ["**/*"];
  const ignore = options.ignore ?? [];
  const text = options.text ?? [
    "**/*.md",
    "**/*.txt",
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.json",
  ];
  const json = options.json ?? ["**/*.json"];
  const mediaTypes = { ...options.mediaTypes };
  validatePatterns(include, ignore, text, json, Object.keys(mediaTypes));
  const includeMatchers = compileGlobPatterns(include);
  const ignoreMatchers = compileGlobPatterns(ignore);
  const textMatchers = compileGlobPatterns(text);
  const jsonMatchers = compileGlobPatterns(json);
  const mediaTypeMatchers = sortedResourceValues(
    Object.entries(mediaTypes).map(([pattern, mediaType]) => ({
      pattern,
      mediaType,
      matcher: compileGlobPattern(pattern),
    })),
    (left, right) => compareText(left.pattern, right.pattern),
  );
  const config = {
    compilerVersion: RESOURCE_COMPILER_VERSION,
    id: options.id,
    version: options.version,
    include: sortedResourceValues(include, compareText),
    ignore: sortedResourceValues(ignore, compareText),
    text: sortedResourceValues(text, compareText),
    json: sortedResourceValues(json, compareText),
    mediaTypes: Object.fromEntries(
      sortedResourceValues(Object.entries(mediaTypes), ([left], [right]) =>
        compareText(left, right),
      ),
    ),
    limits: options.limits ?? {},
  };
  const configDigest = sha256(canonicalJson(config));
  const files: Record<string, ReturnType<typeof binaryResource>> = {};

  async function walk(directory: string, relativeDirectory = ""): Promise<void> {
    const entries = sortedResourceValues(
      await fs.readdir(directory, { withFileTypes: true }),
      (left, right) => compareText(left.name, right.name),
    );
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const selected =
        matchesAny(relative, includeMatchers) && !matchesAny(relative, ignoreMatchers);
      const absolute = pathApi.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (selected) {
          invalidPath();
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        if (selected) {
          invalidPath();
        }
        continue;
      }
      if (!selected) {
        continue;
      }
      const bytes = new Uint8Array(await fs.readFile(absolute));
      const mediaType = mediaTypeFor(relative, mediaTypeMatchers);
      if (matchesAny(relative, jsonMatchers)) {
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new ResourceError("invalid_resource_manifest", "Invalid JSON source resource");
        }
        files[relative] = jsonResource(value);
      } else if (matchesAny(relative, textMatchers)) {
        files[relative] = textResource(bytes, { mediaType });
      } else {
        files[relative] = binaryResource(bytes, mediaType);
      }
    }
  }

  try {
    const rootStat = await fs.lstat(options.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      invalidPath();
    }
    await walk(options.root);
  } catch (error) {
    if (error instanceof ResourceError) {
      throw error;
    }
    throw new ResourceError("invalid_resource_path", "Resource source directory is unavailable");
  }

  const pkg = defineResourcePackage({
    id: options.id,
    version: options.version,
    files,
    ...(options.limits ? { limits: options.limits } : {}),
  } satisfies DefineResourcePackageOptions);
  const generatedSource = renderGeneratedResourcePackage(pkg, configDigest);
  const result = Object.freeze({
    package: pkg,
    compilerVersion: RESOURCE_COMPILER_VERSION,
    configDigest,
    generatedSource,
  });

  const mode = options.mode ?? "memory";
  if (mode !== "memory") {
    if (!options.outputFile) {
      throw new ResourceError("invalid_resource_manifest", "Generated output file is required");
    }
    if (mode === "write") {
      await fs.mkdir(pathApi.dirname(options.outputFile), { recursive: true });
      await fs.writeFile(options.outputFile, generatedSource, "utf8");
    } else {
      let existing: string;
      try {
        existing = await fs.readFile(options.outputFile, "utf8");
      } catch {
        staleResourcePackage();
      }
      if (existing! !== generatedSource) {
        staleResourcePackage();
      }
    }
  }
  return result;
}

/** Convenience API returning the exact package model produced by literal authoring. */
export async function resourcesFromDirectory(
  options: ResourceDirectoryCompilerOptions,
): Promise<ResourcePackage> {
  return (await compileResourceDirectory(options)).package;
}

/** Emits deterministic source with normalized bindings and no host-specific metadata. */
export function renderGeneratedResourcePackage(pkg: ResourcePackage, configDigest: string): string {
  const lines = [
    "// Generated by @sweatpants/core resource compiler. Do not edit.",
    'import { binaryResourceFromBase64, defineResourcePackage } from "@sweatpants/core";',
    "",
    `export const resourceCompilerVersion = ${RESOURCE_COMPILER_VERSION} as const;`,
    `export const resourceCompilerConfigDigest = ${JSON.stringify(configDigest)} as const;`,
    "export const resourcePackage = defineResourcePackage({",
    `  id: ${JSON.stringify(pkg.manifest.id)},`,
    `  version: ${JSON.stringify(pkg.manifest.version)},`,
    "  files: {",
  ];
  for (const path of sortedResourceValues(Object.keys(pkg.manifest.files), compareText)) {
    const bytes = pkg.bindings.read(path)!;
    lines.push(
      `    ${JSON.stringify(path)}: binaryResourceFromBase64(${JSON.stringify(encodeResourceBase64(bytes))}, ${JSON.stringify(pkg.manifest.files[path]!.mediaType)}),`,
    );
  }
  lines.push("  },", `  limits: ${canonicalJson(pkg.limits)},`, "});", "");
  return lines.join("\n");
}

/** Writes or verifies a deterministic generated program identity module. */
export async function generateProgramIdentityModule(options: {
  readonly input: ProgramArtifactIdentityInputV1;
  readonly outputFile: string;
  readonly mode: "write" | "verify";
}): Promise<GeneratedProgramArtifactIdentityV1> {
  const fs = (await loadNodeModule("node:fs/promises")) as FsPromisesPort;
  const pathApi = (await loadNodeModule("node:path")) as PathPort;
  const identity = generateProgramArtifactIdentity(options.input);
  const source = renderGeneratedProgramIdentity(identity);
  if (options.mode === "write") {
    await fs.mkdir(pathApi.dirname(options.outputFile), { recursive: true });
    await fs.writeFile(options.outputFile, source, "utf8");
  } else {
    let existing: string;
    try {
      existing = await fs.readFile(options.outputFile, "utf8");
    } catch {
      staleProgramIdentity();
    }
    if (existing! !== source) {
      staleProgramIdentity();
    }
  }
  return identity;
}

export function renderGeneratedProgramIdentity(
  identity: GeneratedProgramArtifactIdentityV1,
): string {
  return [
    "// Generated by @sweatpants/core program identity generator. Do not edit.",
    `export const programDigest = ${JSON.stringify(identity.digest)} as const;`,
    `export const programIdentityProvenance = Object.freeze(${canonicalJson(identity.provenance)});`,
    "",
  ].join("\n");
}

/** Development watcher reruns the canonical compiler and notifies only on digest changes. */
export async function watchResourceDirectory(
  options: Omit<ResourceDirectoryCompilerOptions, "mode">,
  onChange: (result: CompiledResourceDirectory) => void | Promise<void>,
): Promise<{ readonly close: () => void }> {
  const fs = (await loadNodeModule("node:fs")) as WatchPort;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastDigest = (await compileResourceDirectory({ ...options, mode: "write" })).package.manifest
    .digest;
  const watcher = fs.watch(options.root, { recursive: true }, () => {
    if (closed) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void (async () => {
        const result = await compileResourceDirectory({ ...options, mode: "write" });
        if (closed || result.package.manifest.digest === lastDigest) {
          return;
        }
        lastDigest = result.package.manifest.digest;
        await onChange(result);
      })();
    }, 50);
  });
  return Object.freeze({
    close: () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
      watcher.close();
    },
  });
}

type GlobMatcher = (path: string) => boolean;
type MediaTypeMatcher = {
  readonly pattern: string;
  readonly mediaType: string;
  readonly matcher: GlobMatcher;
};

function mediaTypeFor(path: string, mappings: readonly MediaTypeMatcher[]): string {
  for (const mapping of mappings) {
    if (mapping.matcher(path)) {
      return mapping.mediaType;
    }
  }
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const defaults: Record<string, string> = {
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".ts": "text/typescript; charset=utf-8",
    ".tsx": "text/typescript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
  };
  return defaults[extension] ?? "application/octet-stream";
}

function validatePatterns(...groups: readonly (readonly string[])[]): void {
  for (const group of groups) {
    if (
      !Array.isArray(group) ||
      group.some(
        (pattern) =>
          typeof pattern !== "string" ||
          !pattern ||
          pattern.includes("\\") ||
          [...pattern].some((character) => character.codePointAt(0)! < 0x20),
      )
    ) {
      throw new ResourceError("invalid_resource_manifest", "Invalid resource compiler patterns");
    }
  }
}

function compileGlobPatterns(patterns: readonly string[]): readonly GlobMatcher[] {
  return Object.freeze(patterns.map(compileGlobPattern));
}

function matchesAny(path: string, matchers: readonly GlobMatcher[]): boolean {
  return matchers.some((matcher) => matcher(path));
}

function compileGlobPattern(pattern: string): GlobMatcher {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  const compiled = new RegExp(`${expression}$`, "u");
  return (path: string) => compiled.test(path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidPath(): never {
  throw new ResourceError("invalid_resource_path", "Invalid resource source entry");
}
function staleResourcePackage(): never {
  throw new ResourceError(
    "stale_generated_resource_package",
    "Generated resource package is stale",
  );
}
function staleProgramIdentity(): never {
  throw new ResourceError(
    "stale_generated_program_identity",
    "Generated program identity is stale",
  );
}
