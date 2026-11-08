import { readFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, expectTypeOf, it, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import {
  buildTypeScriptTool,
  type TypeScriptToolBuildInput,
  type WorkflowBuildArtifact,
} from "@sweatpan.ts/codemode-compiler-frontend-typescript/build";
import { sendEmail } from "../fixtures/workflow-build/send-email.ts";
import { draft, approval, send, remove } from "../fixtures/workflow-build/email-effects.ts";
import { type CapabilityRequest } from "@sweatpan.ts/core";
import { createToolAcquisition } from "@sweatpan.ts/tools";
import { createEffectCapabilities } from "@sweatpan.ts/hosting";
import { verifyWorkflowModule, type WorkflowModule } from "@sweatpan.ts/codemode-compiler";
import { schemeWorkflowTarget } from "@sweatpan.ts/codemode-compiler-scheme";
import { createSchemeKernel } from "@sweatpan.ts/codemode-runtime-scheme";
import {
  loadSchemeMachine,
  schemeRuntimeIdentity,
} from "@sweatpan.ts/codemode-runtime-scheme/node";
import { createLuaKernel, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import type { PreparedProgram, Outcome, Operation, ScopeInstruction } from "@sweatpan.ts/execution";
import { luaWorkflowLinker } from "@sweatpan.ts/codemode-compiler-lua/link";
import { luaWorkflowTarget } from "@sweatpan.ts/codemode-compiler-lua";
import { schemeWorkflowLinker } from "@sweatpan.ts/codemode-compiler-scheme/link";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

const effects = { draft, approval, send, remove };
expectTypeOf(sendEmail.body).returns.toEqualTypeOf<
  Operation<string, CapabilityRequest | ScopeInstruction>
>();
const input: TypeScriptToolBuildInput = {
  source: {
    language: "typescript",
    id: "send-email.ts",
    text: readFileSync(
      new URL("../fixtures/workflow-build/send-email.ts", import.meta.url),
      "utf8",
    ),
  },
  modules: {
    "email-effects.ts": readFileSync(
      new URL("../fixtures/workflow-build/email-effects.ts", import.meta.url),
      "utf8",
    ),
  },
  exportName: "sendEmail",
  tool: sendEmail,
};
let cacheDirectory: string;
let built: WorkflowBuildArtifact;
let module: WorkflowModule;
beforeAll(() => {
  // Explicit ScriptC subprocess exception: fresh public-API authored source, never recorded IR.
  cacheDirectory = mkdtempSync(join(tmpdir(), "workflow-build-acceptance-"));
  const cold = buildTypeScriptTool(input, { cacheDirectory });
  expect(cold.cache).toBe("miss");
  built = cold.artifact;
  module = built.module;
});
afterAll(() => {
  if (cacheDirectory) {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

it("public tool build caches verified artifacts and invalidates source, graph and declarations", () => {
  const warm = buildTypeScriptTool(input, { cacheDirectory });
  expect(warm.cache).toBe("hit");
  expect(warm.artifact).toEqual(built);
  for (const changed of [
    {
      ...input,
      tool: {
        ...sendEmail,
        capabilities: {
          ...sendEmail.capabilities,
          draft: { ...draft, context: z.object({ message: z.string() }).strict() },
        },
      },
    },
    {
      ...input,
      source: { ...input.source, text: input.source.text.replace('"sent:"', '"delivered:"') },
    },
    {
      ...input,
      modules: {
        ...input.modules,
        "email-effects.ts": input.modules["email-effects.ts"] + "\n// changed declaration graph\n",
      },
    },
    {
      ...input,
      tool: {
        ...sendEmail,
        capabilities: { ...sendEmail.capabilities, draft: { ...draft, id: "email.draft-next" } },
      },
    },
  ]) {
    const result = buildTypeScriptTool(changed, { cacheDirectory });
    expect(result.cache).toBe("miss");
    expect(result.artifact.key).not.toBe(built.key);
    expect(buildTypeScriptTool(changed, { cacheDirectory })).toEqual({
      artifact: result.artifact,
      cache: "hit",
    });
  }
  const before = readdirSync(cacheDirectory).sort();
  for (const text of [
    input.source.text.replace('"use workflow";', ""),
    input.source.text + '\nconsole.log("must not execute");',
    input.source.text.replace("message: input", "message: globalThis.process"),
    input.source.text.replace("ctx.capabilities.draft", "ctx.capabilities.unknown"),
    input.source.text.replace("if (draft.ok)", "if (input)"),
    input.source.text.replace("function* (input, ctx)", "function* (input: number, ctx)"),
  ]) {
    expect(() =>
      buildTypeScriptTool({ ...input, source: { ...input.source, text } }, { cacheDirectory }),
    ).toThrow(/Tool compilation/);
  }
  // Wrong union-arm access reaches ScriptC's checker, not a recorded-fixture hash check.
  expect(() =>
    buildTypeScriptTool(
      {
        ...input,
        source: {
          ...input.source,
          text: input.source.text.replace('return "draft-failed";', "return draft.value;"),
        },
      },
      { cacheDirectory },
    ),
  ).toThrow(/ScriptC.*rejected input/);
  expect(() =>
    buildTypeScriptTool(
      {
        ...input,
        tool: {
          ...sendEmail,
          capabilities: { ...sendEmail.capabilities, draft: { ...draft, response: z.number() } },
        },
      },
      { cacheDirectory },
    ),
  ).toThrow(/unsupported declaration/);
  expect(readdirSync(cacheDirectory).sort()).toEqual(before);
  expect(buildTypeScriptTool(input, { cacheDirectory }).cache).toBe("hit");
  const path = join(cacheDirectory, `${built.key}.json`);
  const bytes = readFileSync(path, "utf8");
  writeFileSync(path, bytes.replace('"workflow-scheme/1"', '"corrupted"'));
  expect(() => buildTypeScriptTool(input, { cacheDirectory })).toThrow(/integrity/);
  writeFileSync(path, bytes);
});

const bytes = await readFile(luaWasmUrl);
let wasm: Promise<WebAssembly.Module> | undefined;
const loadModule = () => (wasm ??= WebAssembly.compile(bytes));
const allowed = Object.values(effects).map((definition) => definition.id);

// This profile's message payload adapter and capability ceiling belong to assembly.
// Linkers emit code/metadata; they neither grant effects nor choose request schemas.
function decodeExchange(module: WorkflowModule, language: "scheme" | "lua") {
  for (const site of Object.values(module.effects)) {
    if (!allowed.includes(site.effect)) {
      throw new Error("Effect not granted");
    }
  }
  return (boundary: unknown): CapabilityRequest => {
    const envelope = z
      .object({ site: z.string(), value: z.unknown(), request: z.unknown() })
      .parse(boundary);
    const value = language === "scheme" ? envelope.value : envelope.request;
    const declaration = module.effects[envelope.site];
    if (
      !declaration ||
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== "effect" ||
      value[1] !== declaration.effect ||
      typeof value[2] !== "string"
    ) {
      throw new Error("Exchange does not match admitted effect");
    }
    return { effect: declaration.effect, input: { message: value[2] } };
  };
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const [language, artifactSource] of [
    ["typescript", "compiled"],
    ["scheme", "compiled"],
    ["lua", "compiled"],
    ["scheme", "cached"],
    ["lua", "cached"],
  ] as const) {
    for (const scenario of [
      "approve",
      "decline",
      "draft-failed",
      "send-failed",
      "delete-failed",
    ] as const) {
      it(`${runtime.name}: ${language} ${artifactSource} email contract handles ${scenario} with inferred output and shared replies`, async () => {
        await runtime.start(function* () {
          const registry = createEffectCapabilities(runtime, "email-effects");
          const grant = registry.grant(effects);
          const selected =
            artifactSource === "cached"
              ? buildTypeScriptTool(input, { cacheDirectory })
              : { artifact: built, cache: "miss" };
          if (artifactSource === "cached") {
            expect(selected.cache).toBe("hit");
          }
          const portable: WorkflowModule = JSON.parse(JSON.stringify(selected.artifact.module));
          verifyWorkflowModule(portable);
          let recipe: PreparedProgram<unknown, CapabilityRequest, Y>;
          if (language === "typescript") {
            const acquisition = createToolAcquisition(runtime, registry, sendEmail, "email-tool");
            recipe = {
              *acquire() {
                return yield* acquisition.operations.acquire("hello");
              },
            };
          } else if (language === "scheme") {
            const artifact = schemeWorkflowLinker.link({
              module: portable,
              name: "sendEmail",
              identity: schemeRuntimeIdentity,
              caller: { language: "scheme", text: "(sendEmail %input)" },
            });
            recipe = yield* createSchemeKernel(runtime, {
              identity: schemeRuntimeIdentity,
              loadMachine: loadSchemeMachine,
              decodeRequest: decodeExchange(portable, "scheme"),
              decodeResult: (value) => value,
            }).prepare(artifact.source, "hello");
          } else {
            const artifact = luaWorkflowLinker.link({
              module: portable,
              name: "sendEmail",
              identity: "email-lua-fixture",
              caller: { language: "lua", text: "return sendEmail(input)" },
            });
            recipe = yield* createLuaKernel(runtime, {
              loadModule,
              decodeRequest: decodeExchange(portable, "lua"),
              decodeResult: (value) => value,
            }).prepare(artifact.source, "hello");
          }
          let guest = yield* recipe.acquire();
          yield* runtime.composition.ensure(() => guest.close());
          let turn = yield* guest.start();
          const requests: CapabilityRequest[] = [];
          while (turn.kind === "suspended") {
            requests.push(turn.request);
            if (recipe.checkpoints) {
              const saved = yield* recipe.checkpoints.capture(guest);
              yield* guest.close();
              const restored = yield* recipe.checkpoints.restore(saved);
              guest = restored.guest;
              expect(restored.turn).toEqual(turn);
            }
            const key = turn.request.effect;
            const failed =
              (key === effects.draft.id && scenario === "draft-failed") ||
              (key === effects.send.id && scenario === "send-failed") ||
              (key === effects.remove.id && scenario === "delete-failed") ||
              (key === effects.approval.id && ["decline", "delete-failed"].includes(scenario));
            const result: Outcome<string, string> = failed
              ? { ok: false, error: "denied" }
              : { ok: true, value: key === effects.draft.id ? "draft-1" : "receipt-1" };
            const validated = yield* grant.respond(turn.request, result);
            turn = yield* guest.resume({ ok: true, value: validated });
          }
          expect(turn).toEqual({
            kind: "completed",
            value: {
              approve: "sent:receipt-1",
              decline: "declined:draft-1",
              "draft-failed": "draft-failed",
              "send-failed": "send-failed",
              "delete-failed": "delete-failed",
            }[scenario],
          });
          expect(requests).toEqual([
            { effect: effects.draft.id, input: { message: "hello" } },
            ...(scenario === "draft-failed"
              ? []
              : [
                  { effect: effects.approval.id, input: { message: "draft-1" } },
                  {
                    effect: ["decline", "delete-failed"].includes(scenario)
                      ? effects.remove.id
                      : effects.send.id,
                    input: { message: "draft-1" },
                  },
                ]),
          ]);
        }).result;
      });
    }
  }
});

it("portable module verification rejects malformed structure and forged imports before target emission", () => {
  for (const invalid of [
    { ...module, sexpressions: module.sexpressions + " (host-access)" },
    {
      ...module,
      sexpressions: module.sexpressions.replace("(workflow local_0)", "(workflow local_0 local_0)"),
    },
    { ...module, sexpressions: module.sexpressions.replace('"email.draft"', '"ungranted.effect"') },
    {
      ...module,
      sexpressions: module.sexpressions.replace(
        '(json-field local_1 "ok")',
        "(host-access local_1)",
      ),
    },
    { ...module, effects: {} },
    {
      ...module,
      effects: {
        ...module.effects,
        draft: { ...module.effects.draft!, source: { id: "bad", line: 0 } },
      },
    },
    { ...module, entry: { ...module.entry, name: "missing" } },
    { ...module, sexpressions: "(define (workflow local_0) (workflow-return #.(host-access)))" },
  ]) {
    expect(() => schemeWorkflowTarget.emit(invalid)).toThrow(/Invalid workflow module/);
    expect(() =>
      luaWorkflowLinker.link({
        module: invalid,
        name: "sendEmail",
        identity: "fixture",
        caller: { language: "lua", text: "return sendEmail(input)" },
      }),
    ).toThrow(/Invalid workflow module/);
  }
});

it("public linkers validate bindings and pin binding, caller, runtime and metadata", () => {
  for (const linker of [schemeWorkflowLinker, luaWorkflowLinker]) {
    const caller = (name: string) => ({
      language: linker.language,
      text: linker.language === "lua" ? `return ${name}(input)` : `(${name} %input)`,
    });
    const request = {
      module,
      name: "sendEmail",
      identity: "runtime-1",
      caller: caller("sendEmail"),
    };
    const artifact = linker.link(request);
    expect(linker.link(request)).toEqual(artifact);
    expect(
      linker.link({ ...request, name: "deliver", caller: caller("deliver") }).program,
    ).not.toBe(artifact.program);
    expect(linker.link({ ...request, identity: "runtime-2" }).program).not.toBe(artifact.program);
    const changed = {
      ...module,
      effects: Object.fromEntries(
        Object.entries(module.effects).map(([site, effect]) => [
          site,
          { ...effect, source: { ...effect.source, line: effect.source.line + 1 } },
        ]),
      ),
    };
    expect(linker.link({ ...request, module: changed }).program).not.toBe(artifact.program);
    for (const name of linker.language === "lua"
      ? ["input", "local", "__metadata", "workflow", "x)()"]
      : ["root", "define", module.entry.name, "x)()"]) {
      expect(() => linker.link({ ...request, name })).toThrow();
    }
    expect(() =>
      linker.link({ ...request, caller: { ...request.caller, language: "python" } }),
    ).toThrow();
  }
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: public standalone targets execute the same verified module`, async () => {
    await runtime.start(function* () {
      const simple: WorkflowModule = {
        format: "workflow-scheme/1",
        entry: { name: "echo", parameters: "input" },
        effects: {},
        sexpressions: '(define (echo input) (workflow-return (js-add "hello:" input)))',
      };
      const scheme = schemeWorkflowTarget.emit(simple);
      const lua = luaWorkflowTarget.emit(simple);
      const reject = (): never => {
        throw new Error("Unexpected effect");
      };
      const recipes = [
        yield* createSchemeKernel(runtime, {
          identity: schemeRuntimeIdentity,
          loadMachine: loadSchemeMachine,
          decodeRequest: reject,
          decodeResult: (value) => value,
        }).prepare(scheme.source, "world"),
        yield* createLuaKernel(runtime, {
          loadModule,
          decodeRequest: reject,
          decodeResult: (value) => value,
        }).prepare(lua.source, "world"),
      ];
      for (const recipe of recipes) {
        const guest = yield* recipe.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        expect(yield* guest.start()).toEqual({ kind: "completed", value: "hello:world" });
      }
    }).result;
  });
});
