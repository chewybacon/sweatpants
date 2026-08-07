/**
 * Generate Command
 *
 * Generates TypeScript types from an MCP server manifest.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { fetchManifest } from "../lib/fetch-manifest.ts";
import { generateTypes } from "../lib/codegen.ts";

export interface GenerateOptions {
  readonly input: string;
  readonly output: string;
  readonly noHeader: boolean;
}

export async function generate(options: GenerateOptions): Promise<void> {
  const { input, output, noHeader } = options;
  console.log(`Fetching manifest from: ${input}`);

  const manifest = await fetchManifest(input);

  console.log(`Found ${manifest.tools.length} tool(s):`);
  for (const tool of manifest.tools) {
    const elicitCount = Object.keys(tool._meta?.["x-sweatpants"]?.elicits ?? {}).length;
    console.log(`  - ${tool.name}${elicitCount > 0 ? ` (${elicitCount} elicits)` : ""}`);
  }

  const code = generateTypes(manifest, {
    includeHeader: !noHeader,
    sourceUrl: input,
  });

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, code, "utf-8");

  console.log(`\nGenerated types written to: ${output}`);
}
