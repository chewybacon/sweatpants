import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeWorkflowTools, prepareWorkflow, emitSchemeIR, verifySchemeIR } from "../index.js";
import { lowerWorkflow } from "../lower.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(files: Record<string, string>, replacement = "caption(input.title)") {
  const base = resolve(import.meta.dirname, "../../.artifacts/import-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(resolve(base, "case-"));
  directories.push(dir);
  await writeFile(resolve(dir, "package.json"), '{"type":"module"}');
  for (const [name, text] of Object.entries(files)) {
    await writeFile(resolve(dir, name), text);
  }
  const original = await readFile(
    resolve(import.meta.dirname, "../../../../apps/yo-workflow/execution/review-draft.workflow.ts"),
    "utf8",
  );
  const text =
    'import { caption } from "./helper.ts";\n' +
    original.replace("message: input.title", `message: ${replacement}`);
  const id = resolve(dir, "workflow.ts");
  const request = {
    ...analyzeWorkflowTools(text, id)[0],
    source: { id, text, language: "typescript" },
  };
  return { dir, request };
}

test("aliases, duplicate names and a diamond dependency resolve to one shared function", async () => {
  const { request, dir } = await fixture({
    "helper.ts":
      'import { decorate as left } from "./left.ts"; import { decorate as right } from "./right.ts"; export function caption(value: string) { return left(value) + right(value); } export function unused() { return "unused"; }',
    "left.ts":
      'import { decorate as shared } from "./shared.ts"; export function decorate(value: string) { return shared(value); }',
    "right.ts":
      'import { decorate as shared } from "./shared.ts"; export function decorate(value: string) { return shared(value); }',
    "shared.ts": 'export function decorate(value: string) { return "hello " + value; }',
  });
  const prepared = prepareWorkflow(request);
  expect(prepared.diagnostics).toEqual([]);
  expect(prepared.program.functions).toHaveLength(5);
  expect(
    prepared.program.functions.filter((fn) => fn.origin.sourceId === resolve(dir, "shared.ts")),
  ).toHaveLength(1);
  expect(new Set(prepared.program.functions.map((fn) => fn.id)).size).toBe(5);
  expect(emitSchemeIR(prepared.program).payload).not.toContain('"unused"');
  expect(prepared.dependencies).toHaveLength(4);
});

test("imported helper source errors and TypeScript argument errors retain original files", async () => {
  const { request, dir } = await fixture({
    "helper.ts": "export function caption(value: string) { console.log(value); return value; }",
  });
  expect(() => prepareWorkflow(request)).toThrow("Unsupported expression CallExpression");
  try {
    prepareWorkflow(request);
  } catch (error) {
    expect(error).toMatchObject({ position: { sourceId: resolve(dir, "helper.ts"), line: 1 } });
  }
  await writeFile(
    resolve(dir, "helper.ts"),
    "export function caption(value: string) { return value.missing; }",
  );
  const checked = prepareWorkflow(request);
  expect(checked.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "TS2339",
        position: expect.objectContaining({ sourceId: resolve(dir, "helper.ts") }),
      }),
    ]),
  );
});

test.each([
  [
    "export const state = { count: 0 }; export function caption(value: string) { return value; }",
    /only function declarations/,
  ],
  [
    'console.log("init"); export function caption(value: string) { return value; }',
    /only function declarations/,
  ],
  [
    'import "./other.ts"; export function caption(value: string) { return value; }',
    /Side-effect imports/,
  ],
  ['export { caption } from "./other.ts";', /directly exported function declarations/],
  [
    'import { caption as other } from "./other.ts"; export function caption(value: string): string { return other(value); }',
    /import cycles/,
  ],
])("unsupported module semantics fail before pruning: %s", async (helper, message) => {
  const { request } = await fixture({
    "helper.ts": helper,
    "other.ts":
      'import { caption as other } from "./helper.ts"; export function caption(value: string): string { return other(value); }',
  });
  expect(() => prepareWorkflow(request)).toThrow(message);
});

test("IR verification rejects invalid call kinds, capture identities, exits and cleanup ownership", () => {
  const source =
    'import { ensure } from "effection"; function* workflow(ctx) { "use workflow"; let count = 0; const advance = () => { count = count + 1; return count; }; yield* ensure(function* () { yield* ctx.elicit("cleanup"); }); return advance(); }';
  const options = { allowFinally: true, allowEnsure: true };
  const program = lowerWorkflow(source, options);
  const returned = program.functions[0].body.statements.at(-1)!;
  expect(returned.kind).toBe("workflow-return");
  if (returned.kind !== "workflow-return" || returned.value.kind !== "apply") {
    throw Error("Expected call");
  }
  returned.value.callable = "workflow";
  expect(() => verifySchemeIR(program)).toThrow("callable kind mismatch");
  const capture = lowerWorkflow(source, options);
  const binding = capture.functions[0].body.statements[1];
  if (binding.kind !== "define" || binding.value.kind !== "lambda") {
    throw Error("Expected closure");
  }
  binding.value.fn.captures[0] = { ...binding.value.fn.captures[0] };
  expect(() => verifySchemeIR(capture)).toThrow("Invalid IR capture");
  const owner = lowerWorkflow(source, options);
  const ensure = owner.functions[0].body.statements[2];
  if (ensure.kind !== "expression" || ensure.value.kind !== "ensure") {
    throw Error("Expected ensure");
  }
  ensure.value.owner = ensure.value.fn.scope;
  expect(() => verifySchemeIR(owner)).toThrow("wrong owner");
  const exit = lowerWorkflow(source, options);
  const ret = exit.functions[0].body.statements.at(-1)!;
  if (ret.kind !== "workflow-return") {
    throw Error("Expected return");
  }
  ret.target = "missing" as typeof ret.target;
  expect(() => verifySchemeIR(exit)).toThrow("wrong function target");
});

test("helper declaration order preserves inferred closure return types", async () => {
  const { request } = await fixture({
    "helper.ts":
      'export function caption(value: string) { const format = make(value); return format("!"); } function make(value: string) { return (suffix: string) => value + suffix; }',
  });
  const prepared = prepareWorkflow(request);
  expect(prepared.diagnostics).toEqual([]);
  expect(prepared.program.functions).toHaveLength(3);
  expect(emitSchemeIR(prepared.program).payload).toContain("lambda");
});
