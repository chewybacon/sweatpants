import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson } from "@sweatpants/session-contract";
import { build, version as esbuildVersion } from "esbuild";

import type { ConfiguredDurableTool, ProgramRootConfig } from "../config.ts";
import {
  buildDevelopmentCollection,
  type BuiltDevelopmentCollection,
  type ProgramBundleInput,
} from "./collection.ts";
import { importDevelopmentProgramEntry } from "./evaluator-loader.ts";
import { RemoteDevelopmentError } from "./types.ts";

export interface BundleConfiguredProgramsInput {
  readonly projectRoot: string;
  readonly programs: Readonly<Record<string, ProgramRootConfig>>;
  readonly builderVersion: string;
  readonly evaluatorAbi: string;
  readonly platform: string;
  readonly allowedEvaluatorImports?: readonly string[];
}

export interface BundledProgramSource {
  readonly publicKey: string;
  readonly sourcePath: string;
  readonly entryBytes: Uint8Array;
  readonly program: ConfiguredDurableTool;
  readonly schemaCatalogBytes: Uint8Array;
}

export async function bundleConfiguredPrograms(
  input: BundleConfiguredProgramsInput,
): Promise<BuiltDevelopmentCollection> {
  const projectRoot = await realpath(input.projectRoot);
  const allowedEvaluatorImports = input.allowedEvaluatorImports ?? [];
  const bundles: ProgramBundleInput[] = [];
  for (const publicKey of sortText(Object.keys(input.programs))) {
    const root = input.programs[publicKey]!;
    const bundled = await bundleProgramSource({
      projectRoot,
      publicKey,
      root,
      allowedEvaluatorImports,
    });
    bundles.push({
      publicKey,
      program: bundled.program,
      entryBytes: bundled.entryBytes,
      schemaCatalogBytes: bundled.schemaCatalogBytes,
      allowedEvaluatorImports,
    });
  }
  return buildDevelopmentCollection({
    builderVersion: `${input.builderVersion}+esbuild.${esbuildVersion}`,
    evaluatorAbi: input.evaluatorAbi,
    platform: input.platform,
    programs: bundles,
  });
}

export async function bundleProgramSource(input: {
  readonly projectRoot: string;
  readonly publicKey: string;
  readonly root: ProgramRootConfig;
  readonly allowedEvaluatorImports: readonly string[];
}): Promise<BundledProgramSource> {
  const projectRoot = await realpath(input.projectRoot);
  const sourcePath = await confinedSourcePath(
    projectRoot,
    input.root.source.module,
    input.publicKey,
  );
  const wrapper = [
    `import { ${input.root.source.export} as sweatpantsProgram } from ${JSON.stringify(`./${input.root.source.module}`)};`,
    "export default sweatpantsProgram;",
    "",
  ].join("\n");
  let result;
  try {
    result = await build({
      absWorkingDir: projectRoot,
      stdin: {
        contents: wrapper,
        resolveDir: projectRoot,
        sourcefile: `sweatpants-entry-${input.publicKey}.ts`,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "node20",
      charset: "utf8",
      legalComments: "none",
      sourcemap: false,
      sourcesContent: false,
      treeShaking: true,
      external: [...input.allowedEvaluatorImports],
      logLevel: "silent",
    });
  } catch (error) {
    throw new RemoteDevelopmentError(
      "invalid_program_root",
      `Unable to bundle program root ${bounded(input.publicKey)}`,
      { details: { reason: bounded(error instanceof Error ? error.message : error) } },
    );
  }
  if (result.outputFiles.length !== 1) {
    throw new RemoteDevelopmentError(
      "nondeterministic_bundle",
      `Program root ${bounded(input.publicKey)} emitted an unexpected output inventory`,
    );
  }
  const entryBytes = Uint8Array.from(result.outputFiles[0]!.contents);
  const loaded = await importDevelopmentProgramEntry(entryBytes, input.publicKey);
  assertSameProgramContract(input.root.program, loaded, input.publicKey);
  const schemaCatalogBytes = encodeSchemaCatalog(loaded, input.publicKey);
  return Object.freeze({
    publicKey: input.publicKey,
    sourcePath,
    entryBytes,
    program: loaded,
    schemaCatalogBytes,
  });
}

async function confinedSourcePath(
  projectRoot: string,
  modulePath: string,
  publicKey: string,
): Promise<string> {
  if (isAbsolute(modulePath)) {
    throw new RemoteDevelopmentError(
      "invalid_program_root",
      `Program root ${bounded(publicKey)} uses an absolute source module`,
    );
  }
  let candidate: string;
  try {
    candidate = await realpath(resolve(projectRoot, modulePath));
  } catch {
    throw new RemoteDevelopmentError(
      "invalid_program_root",
      `Program root ${bounded(publicKey)} source module is unavailable`,
    );
  }
  const fromRoot = relative(projectRoot, candidate);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new RemoteDevelopmentError(
      "invalid_program_root",
      `Program root ${bounded(publicKey)} source module escapes the project`,
    );
  }
  return candidate;
}

function assertSameProgramContract(
  configured: ConfiguredDurableTool,
  bundled: ConfiguredDurableTool,
  publicKey: string,
): void {
  if (
    canonicalJson(withoutDigest(configured.manifest)) !==
    canonicalJson(withoutDigest(bundled.manifest))
  ) {
    throw new RemoteDevelopmentError(
      "invalid_program_root",
      `Configured and bundled program contracts differ for ${bounded(publicKey)}`,
    );
  }
}

function encodeSchemaCatalog(program: ConfiguredDurableTool, publicKey: string): Uint8Array {
  const artifacts = (
    program as ConfiguredDurableTool & { readonly artifacts?: { readonly catalog?: unknown } }
  ).artifacts;
  if (!artifacts || !Array.isArray(artifacts.catalog)) {
    throw new RemoteDevelopmentError(
      "invalid_program_root",
      `Program root ${bounded(publicKey)} has no runtime schema catalog`,
    );
  }
  const descriptors = artifacts.catalog.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("descriptor" in entry)) {
      throw new RemoteDevelopmentError(
        "invalid_program_root",
        `Program root ${bounded(publicKey)} has an invalid runtime schema catalog`,
      );
    }
    return entry.descriptor;
  });
  return Uint8Array.from(Buffer.from(canonicalJson(descriptors), "utf8"));
}

function withoutDigest(
  manifest: ConfiguredDurableTool["manifest"],
): Omit<ConfiguredDurableTool["manifest"], "digest"> {
  const { digest: _digest, ...contract } = manifest;
  return contract;
}

function sortText(values: Iterable<string>): string[] {
  const result = [...values];
  // oxlint-disable-next-line unicorn/no-array-sort
  return result.sort();
}

function bounded(value: unknown): string {
  return [...String(value)]
    .map((character) => (character.charCodeAt(0) < 32 ? "?" : character))
    .join("")
    .slice(0, 160);
}
