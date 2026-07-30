import type { ConfiguredDurableTool } from "../config.ts";
import { z } from "zod";

import { reconstructCollectionProgram } from "./collection.ts";
import { RemoteDevelopmentError, type DevelopmentCollectionManifestV1 } from "./types.ts";

export async function loadCollectionProgramEntries(
  manifest: DevelopmentCollectionManifestV1,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<ReadonlyMap<string, ConfiguredDurableTool>> {
  const programs = new Map<string, ConfiguredDurableTool>();
  for (const publicKey of sortText(Object.keys(manifest.programs))) {
    const entry = manifest.programs[publicKey]!;
    const bytes = files.get(entry.entrypoint);
    if (!bytes) {
      throw new RemoteDevelopmentError(
        "invalid_collection_manifest",
        `Program entry is missing for ${bounded(publicKey)}`,
      );
    }
    const authored = await importDevelopmentProgramEntry(bytes, publicKey);
    programs.set(publicKey, reconstructCollectionProgram(authored, entry, bytes));
  }
  return programs;
}

export async function importDevelopmentProgramEntry(
  bytes: Uint8Array,
  publicKey: string,
): Promise<ConfiguredDurableTool> {
  try {
    const url = `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
    const module = (await import(url)) as { readonly default?: unknown };
    if (!isDurableTool(module.default)) {
      throw new Error("named export did not produce a durable tool");
    }
    return module.default;
  } catch (error) {
    throw new RemoteDevelopmentError(
      "invalid_program_root",
      `Bundled source export is invalid for ${bounded(publicKey)}`,
      { details: { reason: bounded(error instanceof Error ? error.message : error) } },
    );
  }
}

const durableToolShapeSchema = z
  .object({
    durability: z.literal("crank_native"),
    program: z.custom<unknown>((value) => typeof value === "function"),
    manifest: z.record(z.string(), z.unknown()),
  })
  .loose();

function isDurableTool(value: unknown): value is ConfiguredDurableTool {
  return durableToolShapeSchema.safeParse(value).success;
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
