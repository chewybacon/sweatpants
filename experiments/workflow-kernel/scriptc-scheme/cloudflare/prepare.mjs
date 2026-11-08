import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileWorkflow } from "../live.mjs";
import { input } from "../input.mjs";
const here = new URL("./", import.meta.url);
const assets = new URL(
  "../../../../packages/v2/codemode-runtime-scheme/generated/",
  import.meta.url,
);
const out = new URL("generated/", here);
mkdirSync(out, { recursive: true });
const manifest = readFileSync(new URL("manifest.json", assets), "utf8");
for (const [path, digest] of Object.entries(JSON.parse(manifest))) {
  const bytes = readFileSync(new URL("../" + path, assets));
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("Stale Scheme build: " + path);
  }
}
for (const file of ["kernel.wasm", "reflect.wasm", "wtf8.wasm"]) {
  copyFileSync(new URL(file, assets), new URL(file, out));
}
// Reuse the package-owned platform adapter; only relocate its Wasm imports.
let reflect = readFileSync(new URL("reflect-worker.mjs", assets), "utf8");
for (const [alias, file] of Object.entries({
  "#scheme-kernel-wasm": "./kernel.wasm",
  "#scheme-reflect-wasm": "./reflect.wasm",
  "#scheme-wtf8-wasm": "./wtf8.wasm",
})) {
  if (!reflect.includes(alias)) {
    throw new Error("Missing Scheme Wasm import: " + alias);
  }
  reflect = reflect.replace(alias, file);
}
writeFileSync(new URL("reflect-worker.mjs", out), reflect);
const { module } = compileWorkflow(input);
const identity = createHash("sha256").update(manifest).update(reflect).digest("hex");
writeFileSync(
  new URL("workflow.json", out),
  JSON.stringify(
    {
      module,
      identity,
      authored: input.source.text,
      compiledAt: new Date().toISOString(),
      compiler: "ScriptC 0.3.6 → Scheme S-expression IR",
    },
    null,
    2,
  ),
);
console.log("Compiled current TypeScript with ScriptC; verified and bundled v2 Scheme assets.");
