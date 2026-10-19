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
        "sweatpants/no-conditional-spread": "error",
        curly: ["error", "all"],
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

describe("sweatpants/no-conditional-spread", () => {
  it.each([
    "export const value = { ...(reason === undefined ? {} : { reason }) };",
    "export const value = { ...(enabled && { enabled }) };",
    "export const value = { ...(options ?? {}) };",
    "export const value = { ...(options || fallback) };",
    "export const value = { ...((enabled ? { reason } : {}) as object) };",
    "export const value = <Widget {...(enabled ? { reason } : {})} />;",
  ])("reports an undocumented conditional: %s", (source) => {
    expect(lint(source, "fixture.tsx")).toContain("no-conditional-spread");
  });

  it.each([
    "export const value = [...(items ?? [])];",
    "export const value = [...(enabled ? [entry] : [])];",
    "export const value = fn(...(args ?? []));",
    "export const value = fn(...(enabled ? args : []));",
    "export const value = new Widget(...(args ?? []));",
  ])("accepts conditional iterable composition: %s", (source) => {
    expect(lint(source)).toBe("");
  });

  it("accepts direct optionals and ordinary object, array, and JSX spreads", () => {
    expect(
      lint(
        `
      export const value = { reason, ...options };
      export const values = [...entries];
      export const widget = <Widget {...options} />;
    `,
        "fixture.tsx",
      ),
    ).toBe("");
  });

  it("accepts a local explanation of omission semantics", () => {
    expect(
      lint(`
      export const value = {
        // CONDITIONAL-SPREAD: The patch must leave the stored reason unchanged when absent.
        ...(reason === undefined ? {} : { reason }),
      };
    `),
    ).toBe("");
  });

  it.each([
    "// CONDITIONAL-SPREAD:",
    "// CONDITIONAL-SPREAD: This explains another statement.\n const other = {};",
  ])("rejects missing or detached reasons: %s", (comment) => {
    expect(
      lint(`
      ${comment}
      export const value = { ...(enabled ? { enabled } : {}) };
    `),
    ).toContain("no-conditional-spread");
  });
});

describe("curly", () => {
  it.each([
    "export function run(value: boolean) { if (value) return 1; return 0; }",
    "export function run(value: boolean) { if (value) { return 1; } else return 0; }",
    "export function run(values: number[]) { for (const value of values) console.log(value); }",
  ])("requires braces for control flow: %s", (source) => {
    expect(lint(source)).toContain("curly");
  });

  it("accepts braced returns and expression-bodied callbacks", () => {
    expect(
      lint(`
      export function run(value: boolean) { if (value) { return 1; } return 0; }
      export const identity = (value: number) => value;
    `),
    ).toBe("");
  });
});
