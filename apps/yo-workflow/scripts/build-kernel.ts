import { buildLocalKernel, kernelProvenance } from "./kernel-provenance.ts";
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

await buildLocalKernel();
const result = await build({
  entryPoints: [new URL("../src/workflow/evaluation/kernel.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "TisynKernel",
  platform: "neutral",
  minify: true,
});
const source =
  JSON.stringify(
    {
      generatedFrom: "scripts/build-kernel.ts; resolved kernel; do not edit",
      provenance: await kernelProvenance(result.outputFiles[0].text),
      kernelSource: result.outputFiles[0].text,
    },
    null,
    4,
  ) + "\n";
const target = new URL("../src/workflow/evaluation/generated/kernel-source.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== source) {
    throw new Error("Kernel bundle is stale; run pnpm kernel:build");
  }
} else {
  await mkdir(new URL("../src/workflow/evaluation/generated/", import.meta.url), {
    recursive: true,
  });
  await writeFile(target, source);
}
