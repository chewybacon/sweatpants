import type { DurableTool } from "@sweatpants/durable-execution";

// An authored inventory is intentionally heterogeneous in program input/output types.
// oxlint-disable-next-line typescript/no-explicit-any
export type ConfiguredDurableTool = DurableTool<any, any>;

export interface SweatpantsConfig {
  readonly app: {
    readonly command: readonly [string, ...string[]];
    readonly cwd?: string;
  };
  readonly programs: Readonly<Record<string, ProgramRootConfig>>;
  readonly development: {
    readonly remote: {
      readonly provider: "agentcore";
      readonly environment: string;
      readonly region: string;
    };
  };
}

export interface ProgramRootConfig {
  readonly program: ConfiguredDurableTool;
  readonly source: {
    readonly module: string;
    readonly export: string;
  };
  readonly placement?: "remote" | "local";
}

export function definePrograms(
  programs: Readonly<Record<string, ProgramRootConfig>>,
): Readonly<Record<string, ProgramRootConfig>> {
  const normalized: Record<string, ProgramRootConfig> = {};
  for (const [publicKey, root] of Object.entries(programs)) {
    requireName(publicKey, "program public key");
    if (
      !root ||
      typeof root !== "object" ||
      !hasOnlyKeys(root, ["placement", "program", "source"])
    ) {
      throw new TypeError(`Invalid program root ${publicKey}: unknown configuration field`);
    }
    if (!isDurableTool(root.program)) {
      throw new TypeError(
        `Invalid program root ${publicKey}: expected a crank-native durable tool`,
      );
    }
    if (!root.source || !hasExactKeys(root.source, ["export", "module"])) {
      throw new TypeError(
        `Invalid program root ${publicKey}: source must use the closed module/export shape`,
      );
    }
    const sourceModule = normalizeSourceModule(root.source.module, publicKey);
    if (!/^[$A-Z_a-z][$\w]*$/u.test(root.source.export)) {
      throw new TypeError(
        `Invalid program root ${publicKey}: source export must be a named JavaScript export`,
      );
    }
    if (root.placement !== undefined && root.placement !== "local" && root.placement !== "remote") {
      throw new TypeError(`Invalid program root ${publicKey}: unsupported placement`);
    }
    normalized[publicKey] = Object.freeze({
      program: root.program,
      source: Object.freeze({ module: sourceModule, export: root.source.export }),
      ...(root.placement === undefined ? {} : { placement: root.placement }),
    });
  }
  if (Object.keys(normalized).length === 0) {
    throw new TypeError("Invalid remote config: at least one program root is required");
  }
  return Object.freeze(normalized);
}

export function defineConfig(config: SweatpantsConfig): SweatpantsConfig {
  if (
    !config ||
    typeof config !== "object" ||
    !hasExactKeys(config, ["app", "development", "programs"])
  ) {
    throw new TypeError("Invalid remote config: expected the closed configuration shape");
  }
  if (!config.app || !hasOnlyKeys(config.app, ["command", "cwd"])) {
    throw new TypeError("Invalid remote config: app uses unknown fields");
  }
  const command = config.app.command;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => !part)) {
    throw new TypeError("Invalid remote config: app.command must be a non-empty command tuple");
  }
  if (config.app.cwd !== undefined && !config.app.cwd) {
    throw new TypeError("Invalid remote config: app.cwd must be non-empty when supplied");
  }
  if (!config.development || !hasExactKeys(config.development, ["remote"])) {
    throw new TypeError("Invalid remote config: development uses unknown fields");
  }
  const remote = config.development.remote;
  if (
    !remote ||
    !hasExactKeys(remote, ["environment", "provider", "region"]) ||
    remote.provider !== "agentcore"
  ) {
    throw new TypeError("Invalid remote config: development.remote.provider must be agentcore");
  }
  requireName(remote.environment, "remote environment");
  requireName(remote.region, "AWS region");
  const programs = definePrograms(config.programs);
  return Object.freeze({
    app: Object.freeze({
      command: Object.freeze([...command]) as unknown as readonly [string, ...string[]],
      ...(config.app.cwd === undefined ? {} : { cwd: config.app.cwd }),
    }),
    programs,
    development: Object.freeze({
      remote: Object.freeze({
        provider: "agentcore" as const,
        environment: remote.environment,
        region: remote.region,
      }),
    }),
  });
}

function normalizeSourceModule(value: unknown, publicKey: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /%2e|%2f|%5c/iu.test(value)
  ) {
    throw new TypeError(
      `Invalid program root ${publicKey}: source module must be project-relative POSIX syntax`,
    );
  }
  const parts = value.split("/");
  if (parts[0] === ".") {
    parts.shift();
  }
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(
      `Invalid program root ${publicKey}: source module escapes or is not normalized`,
    );
  }
  return parts.join("/");
}

function isDurableTool(value: unknown): value is ConfiguredDurableTool {
  if (!value || typeof value !== "object") {
    return false;
  }
  const tool = value as Partial<ConfiguredDurableTool>;
  return (
    tool.durability === "crank_native" &&
    typeof tool.program === "function" &&
    Boolean(tool.manifest)
  );
}

function requireName(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`Invalid remote config: ${field} must be a bounded non-empty string`);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = sortText(Object.keys(value));
  const expected = sortText(keys);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sortText(values: Iterable<string>): string[] {
  const result = [...values];
  // oxlint-disable-next-line unicorn/no-array-sort
  return result.sort();
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
