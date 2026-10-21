import { afterEach, describe, expect, test } from "vitest";
import { createServer, build, type ViteDevServer } from "vite";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { workflowPlugin } from "../workflow.ts";

const directories: string[] = [];
const servers: ViteDevServer[] = [];
const changes = new Map<string, () => void>();
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const reviewPath = resolve(
  import.meta.dirname,
  "../../../../apps/yo-workflow/execution/review-draft.workflow.ts",
);
async function fixture() {
  // Under the workspace so SDK resolution matches application source.
  const directory = resolve(import.meta.dirname, "../../.artifacts/workflow-tests");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(resolve(directory, "workflow-"));
  directories.push(root);
  await writeFile(resolve(root, "package.json"), '{"type":"module"}');
  const source = await readFile(reviewPath, "utf8");
  await writeFile(resolve(root, "tool.ts"), source);
  return { root, source, file: resolve(root, "tool.ts") };
}
async function server(root: string) {
  const instance = await createServer({
    configFile: false,
    root,
    plugins: [
      workflowPlugin(),
      {
        name: "test-observe-invalidation",
        enforce: "post",
        handleHotUpdate(context) {
          changes.get(context.file)?.();
          changes.delete(context.file);
        },
      },
    ],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      middlewareMode: true,
      preTransformRequests: false,
      watch: { awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 10 } },
    },
    logLevel: "silent",
  });
  servers.push(instance);
  return instance;
}
// Observe Vite after its asynchronous watcher handling has invalidated the graph.
async function edit(instance: ViteDevServer, file: string, source: string) {
  void instance;
  const changed = new Promise<void>((resolveEvent) => {
    changes.set(file, resolveEvent);
  });
  await writeFile(file, source);
  await changed;
}
describe("directive workflow integration", () => {
  test("ordinary tool imports compile both targets, watch edits, reject failures and recover", async () => {
    const { root, source, file } = await fixture();
    const vite = await server(root);
    const initial = await vite.transformRequest("/tool.ts");
    expect(initial?.code).toContain("registerCompiledWorkflows");
    expect(initial?.code).toContain("workflow-scheme-definitions-v1");
    expect(initial?.code).toContain("piccolo-lua-module-1");
    expect(initial?.code).toContain("createDurableTool");
    await edit(
      vite,
      file,
      source.replace("Release the draft reservation?", "Release the updated draft?"),
    );
    const changed = await vite.transformRequest("/tool.ts");
    expect(changed?.code).toContain("Release the updated draft?");
    expect(changed?.code).not.toContain("Release the draft reservation?");
    await edit(
      vite,
      file,
      source.replace('return "Draft declined";', "return unknownWorkflowValue;"),
    );
    await expect(vite.transformRequest("/tool.ts")).rejects.toThrow();
    await edit(vite, file, source);
    expect((await vite.transformRequest("/tool.ts"))?.code).toContain(
      "Release the draft reservation?",
    );
  }, 60_000);

  test("an inline execute generator uses the same compiler and production transform", async () => {
    const { root, source, file } = await fixture();
    const start = source.indexOf("function* review_draft");
    const end = source.indexOf("\nexport const reviewDraft");
    const inline = source.slice(start, end).trim().replace("function* review_draft", "function*");
    const changed =
      source.slice(0, start) +
      source.slice(end).replace(".execute(review_draft)", `.execute(${inline})`);
    await writeFile(file, changed);
    const result = await build({
      configFile: false,
      root,
      plugins: [workflowPlugin()],
      logLevel: "silent",
      build: {
        write: false,
        lib: { entry: file, formats: ["es"] },
        rollupOptions: { external: [/^@sweatpants\//, "effection", "zod"] },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result) as {
      output: { type: string; code?: string }[];
    };
    const code = output.output.map((item) => item.code ?? "").join("\n");
    expect(code).toContain("registerCompiledWorkflows");
    expect(code).toContain("piccolo-lua-module-1");
    expect(code).not.toContain("@babel");
    expect(code).not.toContain("flowmode-compiler");
  }, 30_000);

  test("local type dependencies invalidate compilation and produce source-located diagnostics", async () => {
    const { root, source, file } = await fixture();
    const types = resolve(root, "input.ts");
    await writeFile(
      types,
      "export type Input = { title: string; recipient: string; metadata: null };\n",
    );
    await writeFile(
      file,
      source.replace(
        "type Input = { title: string; recipient: string; metadata: null };",
        'import type { Input } from "./input.ts";',
      ),
    );
    const vite = await server(root);
    expect((await vite.transformRequest("/tool.ts"))?.code).toContain("registerCompiledWorkflows");
    await edit(vite, types, "export type Input = { recipient: string; metadata: null };\n");
    await expect(vite.transformRequest("/tool.ts")).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`${file}:.*title`)),
      loc: expect.objectContaining({ file, line: expect.any(Number) }),
    });
  }, 30_000);

  test("transitive runtime helper edits invalidate both artifacts and recover after failure", async () => {
    const { root, source, file } = await fixture();
    const helper = resolve(root, "helper.ts"),
      caption = resolve(root, "caption.ts");
    await writeFile(
      helper,
      'import { caption } from "./caption.ts"; export function format(value: string) { return caption(value); }',
    );
    await writeFile(caption, 'export function caption(value: string) { return "first:" + value; }');
    await writeFile(
      file,
      'import { format } from "./helper.ts";\n' +
        source.replace("message: input.title", "message: format(input.title)"),
    );
    const vite = await server(root);
    expect((await vite.transformRequest("/tool.ts"))?.code).toContain("first:");
    await edit(
      vite,
      caption,
      'export function caption(value: string) { return "second:" + value; }',
    );
    const updated = (await vite.transformRequest("/tool.ts"))?.code;
    expect(updated).toContain("second:");
    expect(updated).not.toContain("first:");
    await edit(
      vite,
      caption,
      "export function caption(value: string) { console.log(value); return value; }",
    );
    await expect(vite.transformRequest("/tool.ts")).rejects.toMatchObject({
      loc: expect.objectContaining({ file: caption }),
    });
    await edit(
      vite,
      caption,
      'export function caption(value: string) { return "recovered:" + value; }',
    );
    expect((await vite.transformRequest("/tool.ts"))?.code).toContain("recovered:");
  }, 30_000);

  test("tools without the directive are unchanged", async () => {
    const { root, source, file } = await fixture();
    await writeFile(file, source.replace('"use workflow";', ""));
    const vite = await server(root);
    expect((await vite.transformRequest("/tool.ts"))?.code).not.toContain(
      "registerCompiledWorkflows",
    );
  });
});
