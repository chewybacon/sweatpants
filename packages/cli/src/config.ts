import { field } from "configliere";
import { z } from "zod";

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
  return normalizePrograms(parsePrograms(programs));
}

export function defineConfig(config: SweatpantsConfig): SweatpantsConfig {
  const parsed = parseConfig(config);
  const programs = normalizePrograms(parsed.programs);
  return Object.freeze({
    app: Object.freeze({
      command: Object.freeze([...parsed.app.command]) as unknown as readonly [string, ...string[]],
      cwd: parsed.app.cwd,
    }),
    programs,
    development: Object.freeze({
      remote: Object.freeze({
        provider: "agentcore" as const,
        environment: parsed.development.remote.environment,
        region: parsed.development.remote.region,
      }),
    }),
  });
}

function normalizeSourceModule(value: unknown, publicKey: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
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

function normalizePrograms(
  programs: Readonly<Record<string, ParsedProgramRoot>>,
): Readonly<Record<string, ProgramRootConfig>> {
  const normalized: Record<string, ProgramRootConfig> = {};
  for (const [publicKey, root] of Object.entries(programs)) {
    const sourceModule = normalizeSourceModule(root.source.module, publicKey);
    normalized[publicKey] = Object.freeze({
      program: root.program,
      source: Object.freeze({ module: sourceModule, export: root.source.export }),
      placement: root.placement,
    });
  }
  return Object.freeze(normalized);
}

function parsePrograms(programs: unknown): ParsedPrograms {
  const result = programsField.parse({
    values: [{ name: "sweatpants.config.ts", value: programs }],
  });
  if (!result.ok) {
    throw new TypeError(`Invalid program roots: ${result.error.message}`);
  }
  return result.value;
}

function parseConfig(config: unknown): ParsedSweatpantsConfig {
  const result = configField.parse({
    values: [{ name: "sweatpants.config.ts", value: config }],
  });
  if (!result.ok) {
    throw new TypeError(`Invalid remote config: ${result.error.message}`);
  }
  return result.value;
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

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}

const boundedName = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacter(value), "must not contain control characters");
const programRootSchema = z.strictObject({
  program: z.custom<ConfiguredDurableTool>(isDurableTool),
  source: z.strictObject({
    module: z.string().min(1),
    export: z.string().regex(/^[$A-Z_a-z][$\w]*$/u),
  }),
  placement: z.enum(["local", "remote"]).optional(),
});
const programsSchema = z
  .record(boundedName, programRootSchema)
  .refine((value) => Object.keys(value).length > 0, "at least one program root is required");
const configSchema = z.strictObject({
  app: z.strictObject({
    command: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).optional(),
  }),
  programs: programsSchema,
  development: z.strictObject({
    remote: z.strictObject({
      provider: z.literal("agentcore"),
      environment: boundedName,
      region: boundedName,
    }),
  }),
});

type ParsedProgramRoot = z.infer<typeof programRootSchema>;
type ParsedPrograms = z.infer<typeof programsSchema>;
type ParsedSweatpantsConfig = z.infer<typeof configSchema>;
const programsField = field(programsSchema);
const configField = field(configSchema);
