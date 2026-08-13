import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterAll } from "vitest";

/**
 * Fixture tests for the custom oxlint rules.
 *
 * These rules were previously verified by hand-editing a source file, checking
 * the count, and reverting. That is not evidence: it does not run in CI, and it
 * silently stopped covering anything the moment the rule changed. The bug that
 * motivated this file — prose punctuation inside a justification comment
 * defeating the adjacency check — was introduced and shipped precisely because
 * no fixture pinned it.
 *
 * Each case runs the real linter over a temporary workspace rather than
 * importing rule internals, so what is asserted is what CI enforces.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const workspaces: string[] = [];

function lint(source: string, filename = "fixture.ts"): string {
  const dir = mkdtempSync(join(tmpdir(), "sweatpants-lint-"));
  workspaces.push(dir);
  cpSync(join(repoRoot, "scripts", "oxlint-plugin-sweatpants.mjs"), join(dir, "plugin.mjs"));
  writeFileSync(
    join(dir, ".oxlintrc.json"),
    JSON.stringify({
      plugins: [],
      jsPlugins: ["./plugin.mjs"],
      rules: {
        "sweatpants/documented-scope-crossing": "error",
        "sweatpants/documented-weld": "error",
        "sweatpants/no-nested-yield": "error",
      },
    }),
  );
  writeFileSync(join(dir, filename), source);
  try {
    execFileSync(join(repoRoot, "node_modules", ".bin", "oxlint"), ["."], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "";
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
}

afterAll(() => {
  for (const dir of workspaces) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sweatpants/documented-scope-crossing", () => {
  it("reports a foreign bind with no justification", () => {
    const output = lint(`
      declare const ModelProviderPort: { bind: (scope: unknown) => unknown };
      declare const otherScope: unknown;
      export const provider = ModelProviderPort.bind(otherScope);
    `);
    expect(output).toContain("documented-scope-crossing");
  });

  it("reports a justification that omits the kind", () => {
    const output = lint(`
      declare const ModelProviderPort: { bind: (scope: unknown) => unknown };
      declare const otherScope: unknown;
      // SCOPE-CROSSING: the engine runs in a writer task.
      export const provider = ModelProviderPort.bind(otherScope);
    `);
    expect(output).toContain("documented-scope-crossing");
  });

  it("accepts a justification naming a recognised kind", () => {
    for (const kind of ["missing node", "ownership"]) {
      const output = lint(`
        declare const ModelProviderPort: { bind: (scope: unknown) => unknown };
        declare const otherScope: unknown;
        // SCOPE-CROSSING (${kind}): the engine runs in a Host-owned writer task.
        export const provider = ModelProviderPort.bind(otherScope);
      `);
      expect(output, `kind ${kind} should be accepted`).toBe("");
    }
  });

  it("rejects distribution as a kind, because binding is the defect there", () => {
    const output = lint(`
      declare const TokenBufferPort: { bind: (scope: unknown) => unknown };
      declare const remoteScope: unknown;
      // SCOPE-CROSSING (distribution): the buffer lives in another isolate.
      export const buffer = TokenBufferPort.bind(remoteScope);
    `);
    expect(output).toContain("documented-scope-crossing");
  });

  it("accepts a justification containing prose punctuation", () => {
    // Regression: an earlier adjacency check scanned raw text for `;` and `{}`,
    // so a semicolon inside the comment made the rule reject its own format.
    const output = lint(`
      declare const ToolSessionStorePort: { bind: (scope: unknown) => unknown };
      declare const ownerScope: unknown;
      // SCOPE-CROSSING (ownership): the store belongs to the registry; callers
      // do not configure it { and braces in prose must not matter either }.
      export const store = ToolSessionStorePort.bind(ownerScope);
    `);
    expect(output).toBe("");
  });

  it("reports when real code separates the justification from the bind", () => {
    const output = lint(`
      declare const ModelProviderPort: { bind: (scope: unknown) => unknown };
      declare const otherScope: unknown;
      // SCOPE-CROSSING (ownership): this comment documents something else.
      export const unrelated = 1;
      export const provider = ModelProviderPort.bind(otherScope);
    `);
    expect(output).toContain("documented-scope-crossing");
  });

  it("exempts a self-bind, which does not change dispatch", () => {
    const output = lint(`
      declare const ModelProviderPort: { bind: (scope: unknown) => unknown };
      declare function useScope(): unknown;
      export function* build() {
        return ModelProviderPort.bind(yield* useScope());
      }
    `);
    expect(output).toBe("");
  });
});

describe("sweatpants/no-nested-yield", () => {
  it("reports an operation nested inside another yield expression", () => {
    const output = lint(`
      declare function driver(): Generator<unknown, { load(): Generator<unknown, string> }>;
      export function* load() {
        return yield* (yield* driver()).load();
      }
    `);
    expect(output).toContain("no-nested-yield");
  });

  it("accepts a named effectful intermediate value", () => {
    const output = lint(`
      declare function driver(): Generator<unknown, { load(): Generator<unknown, string> }>;
      export function* load() {
        const selected = yield* driver();
        return yield* selected.load();
      }
    `);
    expect(output).toBe("");
  });
});

describe("sweatpants/documented-weld", () => {
  it("reports an undocumented double assertion", () => {
    const output = lint(`
      declare const value: string;
      export const welded = value as unknown as number;
    `);
    expect(output).toContain("documented-weld");
  });

  it("accepts a documented double assertion, including one with prose punctuation", () => {
    const output = lint(`
      declare const value: string;
      // SAFETY: the caller pins the element type; erasure is confined here.
      export const welded = value as unknown as number;
    `);
    expect(output).toBe("");
  });
});
