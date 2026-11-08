import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// Private Node/build-time integration. Do not re-export through the portable root.
// These two subpaths are exposed by our package-exports-only pnpm patch.
import { runFrontend } from "@scriptc/compiler/frontend/pipeline";
import { loadProgram } from "@scriptc/compiler/frontend/program-node";

export type ScriptcModule = NonNullable<
  ReturnType<ReturnType<typeof runFrontend>["lower"]>["module"]
>;

export const scriptcCompiler = "@scriptc/compiler@0.3.6";

/** Lower already-admitted TypeScript. Never execute authored code or emit LLVM.
 * The caller owns source files; this function owns and closes the tsgo session.
 * Raw ScriptC IR is private to the frontend implementation and its build tooling.
 */
export function lowerScriptcModule(entryPath: string, exports: readonly string[]): ScriptcModule {
  if (exports.length === 0) {
    throw new Error("ScriptC lowering requires explicit entry exports");
  }
  const frontend = runFrontend(entryPath, loadProgram);
  try {
    if (frontend.preflight.length) {
      throw new Error(`ScriptC preflight rejected input: ${JSON.stringify(frontend.preflight)}`);
    }
    const result = frontend.lower({ libRoots: exports });
    if (result.diagnostics.length || !result.module) {
      throw new Error(`ScriptC lowering rejected input: ${JSON.stringify(result.diagnostics)}`);
    }
    for (const name of exports) {
      if (!result.module.functions.some((fn) => fn.name === name || fn.sourceName === name)) {
        throw new Error(`ScriptC did not retain requested entry: ${name}`);
      }
    }
    return result.module;
  } finally {
    frontend.dispose();
  }
}

/** In-memory source graph adapter for build tools. The compiler still uses files,
 * but callers never own a scratch directory or tsgo lifetime. No host paths are
 * accepted as source IDs, and returned locations use the supplied relative IDs.
 */
export function lowerScriptcSources(
  sources: Readonly<Record<string, string>>,
  entry: string,
  exports: readonly string[],
): ScriptcModule {
  const ids = Object.keys(sources);
  for (const id of ids) {
    if (
      !id.endsWith(".ts") ||
      id.includes("\\") ||
      id.includes(":") ||
      id.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Invalid TypeScript source ID: ${id}`);
    }
  }
  if (!Object.hasOwn(sources, entry)) {
    throw new Error(`Missing TypeScript entry source: ${entry}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "sweatpants-scriptc-"));
  try {
    const paths = new Map<string, string>();
    for (const id of ids) {
      const path = join(scratch, id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, sources[id]);
      paths.set(path, id);
    }
    const module = lowerScriptcModule(join(scratch, entry), exports);
    // Rewrite source-location fields only, never authored string literal values.
    function normalize(node: unknown): void {
      if (typeof node !== "object" || node === null) {
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (
          (key === "file" || key === "sourceFile") &&
          typeof value === "string" &&
          paths.has(value)
        ) {
          (node as Record<string, unknown>)[key] = paths.get(value);
        } else {
          normalize(value);
        }
      }
    }
    normalize(module);
    return module;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
