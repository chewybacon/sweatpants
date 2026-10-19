import { CrankError } from "./errors.ts";

/** Named source module supplied to the static durable-purity scanner. */
export interface DurableSourceModule {
  id: string;
  source: string;
  firstParty?: boolean;
}

/** Scanner policy including source modules and explicitly permitted imports. */
export interface DurablePurityScanOptions {
  entry: string;
  modules: ReadonlyMap<string, DurableSourceModule> | Readonly<Record<string, DurableSourceModule>>;
  pureExternalPackages?: ReadonlySet<string> | readonly string[];
  includedSourcePackages?: ReadonlySet<string> | readonly string[];
  effectHandlerModules?: ReadonlySet<string> | readonly string[];
}

/** Stable source-location finding for one prohibited durable-program construct. */
export interface DurablePurityViolation {
  moduleId: string;
  code:
    | "banned_api"
    | "dynamic_loading"
    | "unlisted_external_package"
    | "effect_handler_import"
    | "missing_source_module";
  detail: string;
  index?: number;
}

/** Complete deterministic purity-scan result. */
export interface DurablePurityScanResult {
  ok: boolean;
  scanned: string[];
  violations: DurablePurityViolation[];
  assurance: "guardrail_only";
}

const BANNED: Array<readonly [RegExp, string]> = [
  [/\bMath\s*\.\s*random\s*\(/g, "Math.random"],
  [/\bDate\s*\.\s*now\s*\(/g, "Date.now"],
  [/\bcrypto\s*\.\s*randomUUID\s*\(/g, "crypto.randomUUID"],
  [/\b(?:setTimeout|setInterval|setImmediate)\s*\(/g, "timer"],
  [/\bfetch\s*\(/g, "fetch"],
  [/\b(?:eval|Function)\s*\(/g, "dynamic evaluation"],
  [/\bprocess\s*\.\s*env\b/g, "process.env"],
  [/\b(?:readFile|writeFile|open|createReadStream|createWriteStream)\s*\(/g, "filesystem"],
];

/** Scans authored source without executing or importing it. */
export function scanDurableProgramSources(
  options: DurablePurityScanOptions,
): DurablePurityScanResult {
  const modules =
    options.modules instanceof Map ? options.modules : new Map(Object.entries(options.modules));
  const pureExternals = asSet(options.pureExternalPackages);
  const includedPackages = asSet(options.includedSourcePackages);
  const handlerModules = asSet(options.effectHandlerModules);
  const visited = new Set<string>();
  const violations: DurablePurityViolation[] = [];
  const pending = [options.entry];

  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) {
      continue;
    }
    visited.add(id);
    const module = modules.get(id);
    if (!module) {
      violations.push({
        moduleId: id,
        code: "missing_source_module",
        detail: "Statically resolved controlled module is unavailable",
      });
      continue;
    }
    for (const [pattern, detail] of BANNED) {
      pattern.lastIndex = 0;
      for (
        let match = pattern.exec(stripCommentsAndStrings(module.source));
        match;
        match = pattern.exec(stripCommentsAndStrings(module.source))
      ) {
        violations.push({ moduleId: id, code: "banned_api", detail, index: match.index });
      }
    }
    const sanitized = stripComments(module.source);
    for (const match of sanitized.matchAll(/\bimport\s*\(/g)) {
      violations.push({
        moduleId: id,
        code: "dynamic_loading",
        detail: "dynamic import()",
        index: match.index,
      });
    }
    for (const match of sanitized.matchAll(/\brequire\s*\((?!\s*["'][^"']+["']\s*\))/g)) {
      violations.push({
        moduleId: id,
        code: "dynamic_loading",
        detail: "computed require()",
        index: match.index,
      });
    }
    for (const specifier of staticImports(sanitized)) {
      const resolved = resolveModuleId(id, specifier, modules);
      if (resolved) {
        if (handlerModules.has(resolved)) {
          violations.push({
            moduleId: id,
            code: "effect_handler_import",
            detail: `Imports concrete handler ${specifier}`,
          });
        } else {
          pending.push(resolved);
        }
        continue;
      }
      const packageName = externalPackage(specifier);
      if (!packageName) {
        continue;
      }
      if (includedPackages.has(packageName)) {
        const sourceId = [...modules.keys()].find(
          (candidate) => candidate === packageName || candidate.startsWith(`${packageName}/`),
        );
        if (sourceId) {
          pending.push(sourceId);
        } else {
          violations.push({
            moduleId: id,
            code: "missing_source_module",
            detail: `Included source package ${packageName} is unavailable`,
          });
        }
      } else if (!pureExternals.has(packageName)) {
        violations.push({ moduleId: id, code: "unlisted_external_package", detail: packageName });
      }
    }
  }

  return {
    ok: violations.length === 0,
    scanned: sortedStrings(visited),
    violations,
    assurance: "guardrail_only",
  };
}

/** Fails fast when static scanning finds a prohibited nondurable construct. */
export function assertDurableProgramSources(options: DurablePurityScanOptions): void {
  const result = scanDurableProgramSources(options);
  if (!result.ok) {
    throw new CrankError("durable_purity_violation", "Durable source guardrail failed", {
      violations: result.violations.map((violation) => ({
        moduleId: violation.moduleId,
        code: violation.code,
        detail: violation.detail,
        /* CONDITIONAL-SPREAD: Omit absent index from durable execution records; explicit undefined is not a portable JSON value. */
        ...(violation.index !== undefined ? { index: violation.index } : {}),
      })),
      assurance: result.assurance,
    });
  }
}

function staticImports(source: string): string[] {
  const values: string[] = [];
  const patterns = [
    /\bimport\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        values.push(match[1]);
      }
    }
  }
  return values;
}

function resolveModuleId(
  importer: string,
  specifier: string,
  modules: ReadonlyMap<string, DurableSourceModule>,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return modules.has(specifier) ? specifier : undefined;
  }
  const base = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || !part) {
      continue;
    }
    if (part === "..") {
      base.pop();
    } else {
      base.push(part);
    }
  }
  const candidate = base.join("/");
  return [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}/index.ts`].find((value) =>
    modules.has(value),
  );
}

function externalPackage(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return specifier.startsWith("node:") ? specifier : undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function stripCommentsAndStrings(source: string): string {
  return stripComments(source).replace(
    /`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs,
    (value) => " ".repeat(value.length),
  );
}

function asSet(value: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
  return value instanceof Set ? value : new Set(value ?? []);
}

function sortedStrings(values: Iterable<string>): string[] {
  const result: string[] = [];
  for (const value of values) {
    let index = 0;
    while (index < result.length) {
      const current = result[index];
      if (current === undefined || current >= value) {
        break;
      }
      index += 1;
    }
    result.splice(index, 0, value);
  }
  return result;
}
