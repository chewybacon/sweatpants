/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createSchemeMachine, type HootProcedures } from "./machine.ts";
import type { SchemeMachine } from "./contracts.ts";

const manifestUrl = new URL("../generated/manifest.json", import.meta.url);
const manifestText = readFileSync(manifestUrl, "utf8");
const manifest: Record<string, string> = JSON.parse(manifestText);
/** Includes VM, reflection helpers, codecs, scope adapter and build provenance. */
export const schemeRuntimeIdentity = createHash("sha256").update(manifestText).digest("hex");
function verifyBuild() {
  for (const [path, expected] of Object.entries(manifest)) {
    const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
    if (createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error(`Stale v2 Scheme asset: ${path}`);
    }
  }
}
/** Load a fresh verified Execution machine; no authored program is run here. */
export async function loadSchemeMachine(): Promise<SchemeMachine> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 24 || (major === 24 && minor! < 22)) {
    throw new Error(
      "Scheme Execution requires Node >=24.22; older V8 can crash compiling Hoot tail calls",
    );
  }
  verifyBuild();
  const { Scheme } = createRequire(import.meta.url)("../generated/reflect.cjs") as {
    Scheme: {
      load_main(path: string, options: { reflect_wasm_dir: string }): Promise<HootProcedures>;
    };
  };
  const procedures = await Scheme.load_main(
    fileURLToPath(new URL("../generated/kernel.wasm", import.meta.url)),
    {
      reflect_wasm_dir: fileURLToPath(new URL("../generated/", import.meta.url)),
    },
  );
  return createSchemeMachine(procedures);
}
