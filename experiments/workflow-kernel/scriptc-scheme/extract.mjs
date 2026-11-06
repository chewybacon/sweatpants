// Run with Node 24+ and tsx; uses the frontend package's pinned dependency.
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  lowerScriptcModule,
  scriptcCompiler,
} from "../../../packages/v2/codemode-compiler-frontend-typescript/src/scriptc.ts";
const entry = resolve(import.meta.dirname, "review.ts");
const module = lowerScriptcModule(entry, ["review"]);
const json = JSON.stringify(module, null, 2).replaceAll(entry, "review.ts") + "\n";
writeFileSync(new URL("./review.ir.json", import.meta.url), json);
console.log(
  JSON.stringify(
    {
      compiler: scriptcCompiler,
      sourceSha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
      irSha256: createHash("sha256").update(json).digest("hex"),
      preflight: [],
      diagnostics: [],
    },
    null,
    2,
  ),
);
