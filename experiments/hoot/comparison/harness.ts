import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { run } from "effection";
import { assertJson } from "@sweatpants/foundation";
import {
  createDurableToolRegistry,
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
  stableProgramAttachmentId,
} from "@sweatpants/durable-execution";
import {
  createCapabilityKeyring,
  createDurableSchemaRegistry,
  createWorkflowProgramDriver,
} from "@sweatpants/journal-authority";
import {
  createAuthorityScenarioDriver,
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "@sweatpants/journal-authority/testing";
import { ask } from "../../../apps/yo-workflow/src/workflow/tools/ask.ts";
import { createTisynTool } from "../../../apps/yo-workflow/src/workflow/tisyn.ts";
import { TisynEvaluationPort } from "../../../apps/yo-workflow/src/workflow/evaluation/port.ts";
import { createQuickJSEvaluationDriver } from "../../../apps/yo-workflow/src/workflow/evaluation/quickjs.ts";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { memoizePromiseFactory, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { scheme } from "../runner.ts";
import { createSchemeDriver, SchemeEvaluationPort, type Machine } from "../evaluation.ts";
import { cases, type Language } from "./reference.ts";
const require = createRequire(import.meta.url);
const { Scheme } = require("../runtime/reflect-restricted.cjs") as {
  Scheme: { load_main(path: string, options: { reflect_wasm_dir: string }): Promise<Machine> };
};
const load = () =>
  Scheme.load_main(fileURLToPath(new URL("../runtime/journal.wasm", import.meta.url)), {
    reflect_wasm_dir: fileURLToPath(new URL("../runtime", import.meta.url)),
  });
const quickjs = memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(variant));

// Every reply crosses a serialized authority snapshot and a fresh evaluator.
export async function execute(
  language: Language,
  source: string,
  replies: readonly string[],
  stop?: "decline" | "cancel",
  stopAt = 0,
) {
  const runner = language === "scheme" ? scheme : createTisynTool([ask]).build();
  const tools = [runner, ask];
  const registry = createDurableToolRegistry(tools);
  const attach = {
    sessionId: "compare",
    taskId: "turn-0/root",
    executionEpoch: 1,
    program: {
      id: runner.manifest.programId,
      version: runner.manifest.version,
      digest: runner.manifest.digest,
    },
    input: assertJson(language === "scheme" ? { source } : { program: source }),
    route: { driverKind: "program" },
  };
  const options = {
    journalId: "compare",
    journalIncarnation: "1",
    keyring: createCapabilityKeyring("compare", [
      { keyId: "test", secret: "comparison-test-secret-256-bits-not-production" },
    ]),
    schemaRegistry: createDurableSchemaRegistry(tools.flatMap((t) => [...t.artifacts.catalog])),
  };
  let saved: Parameters<typeof createAuthorityScenarioDriver>[0]["snapshot"];
  const questions: { prompt: string; suggestions?: string[] }[] = [];
  let previous: unknown[] = [];
  const live = new Set<string>();
  for (let turn = 0; turn < 16; turn++) {
    const step = await run(function* () {
      const authority = yield* createAuthorityScenarioDriver({
        ...options,
        ...(saved ? { snapshot: saved } : {}),
      });
      if (!saved)
        yield* authority.openTask({
          ...attach,
          turnId: "turn-0",
          manifest: runner.manifest,
          attachmentId: stableProgramAttachmentId(attach),
          audience: "program-host",
        });
      if (saved) {
        assert.deepEqual(
          authority.readJournal(attach.sessionId).slice(0, previous.length),
          previous,
        );
        const journal = authority.readJournal(attach.sessionId);
        const resolved = new Set(
          journal.flatMap((r) => (r.payload.type === "PullResolved" ? [r.payload.pullId] : [])),
        );
        const pending = journal.find(
          (r) =>
            r.payload.type === "PullRequested" &&
            r.payload.descriptor.kind === "elicit" &&
            !resolved.has(r.payload.pullId),
        )?.payload;
        assert.ok(
          pending?.type === "PullRequested" && pending.descriptor.kind === "elicit",
          "Expected pending Ask",
        );
        questions.push(pending.descriptor.context as { prompt: string; suggestions?: string[] });
        const reply = replies[turn - 1];
        const stopping = stop !== undefined && turn - 1 === stopAt;
        if (!stopping && reply === undefined)
          throw new Error("Program asked more questions than the requested workflow");
        const resolution = yield* authority.resolve({
          capability: authority.resolutionCapability(
            attach.sessionId,
            pending.taskId,
            pending.pullId,
          ),
          audience: "user:reply",
          outcome: {
            status: "ok",
            value: stopping ? { action: stop! } : { action: "accept", content: { reply: reply! } },
          },
        });
        assert.notEqual(resolution.status, "rejected");
      }
      const outcome = yield* ProgramDriverRegistryContext.with(
        createProgramDriverRegistry([["program", createWorkflowProgramDriver(registry)]]),
        function* () {
          return yield* withProgramDriverTestScope(authority, function* () {
            if (language === "scheme") {
              yield* SchemeEvaluationPort.installDriver(createSchemeDriver(load));
              yield* SchemeEvaluationPort.api.around({
                *open(args, next) {
                  const h = yield* next(...args);
                  live.add(h);
                  return h;
                },
                *close([h], next) {
                  yield* next(h);
                  live.delete(h);
                },
              });
            } else {
              yield* TisynEvaluationPort.installDriver(createQuickJSEvaluationDriver(quickjs));
              yield* TisynEvaluationPort.api.around({
                *open(args, next) {
                  const h = yield* next(...args);
                  live.add(h);
                  return h;
                },
                *close([h], next) {
                  yield* next(h);
                  live.delete(h);
                },
              });
            }
            return yield* driveInstalledTestProgramTree({ attach });
          });
        },
      );
      assert.equal(live.size, 0, "Evaluator leaked after activation");
      const journal = authority.readJournal(attach.sessionId);
      assert.deepEqual(journal.slice(0, previous.length), previous);
      return { outcome, journal, snapshot: authority.exportSnapshot() };
    });
    if (step.outcome.state === "completed") {
      const randomRequests = step.journal.flatMap((r) =>
        r.payload.type === "PullRequested" &&
        r.payload.descriptor.kind === "record" &&
        r.payload.descriptor.key.startsWith("tisyn.random/v2:")
          ? [r.payload]
          : [],
      );
      const random = randomRequests.map((request) => {
        const resolution = step.journal.find(
          (r) => r.payload.type === "PullResolved" && r.payload.pullId === request.pullId,
        )?.payload;
        assert.ok(resolution?.type === "PullResolved" && resolution.outcome.status === "ok");
        return resolution.outcome.value;
      });
      return {
        value: step.outcome.value,
        questions,
        random,
        restores: turn,
        journalRecords: step.journal.length,
      };
    }
    assert.equal(step.outcome.state, "parked", JSON.stringify(step.outcome));
    previous = step.journal;
    saved = JSON.parse(JSON.stringify(step.snapshot));
  }
  throw new Error("Interaction limit exceeded");
}
export async function verify(language: Language, source: string, task: (typeof cases)[number]) {
  const actual = await execute(language, source, task.replies);
  assert.equal(actual.questions.length, task.replies.length, "Question count mismatch");
  if (task.id === "greeting")
    assert.deepEqual(actual.value, { status: "done", greeting: `Hello, ${task.replies[0]}!` });
  if (task.id === "badge") {
    assert.deepEqual(actual.value, { status: "done", name: "Grace", color: "green" });
    for (const [index, name, color] of [
      [2, "Ada", "blue"],
      [4, "Grace", "blue"],
      [6, "Grace", "green"],
    ] as const) {
      assert.ok(
        actual.questions[index].prompt.includes(name) &&
          actual.questions[index].prompt.includes(color),
        "Review omitted current values",
      );
      assert.deepEqual([...(actual.questions[index].suggestions ?? [])].sort(), [
        "change color",
        "change name",
        "done",
      ]);
    }
  }
  if (task.id === "prs") {
    assert.equal(actual.random.length, 3, "Exactly one draw per valid round");
    const expected = { status: "done", wins: 0, losses: 0, ties: 0 };
    for (let i = 0; i < 3; i++) {
      const player = task.replies[i + 1],
        computer = actual.random[i];
      assert.ok(["rock", "paper", "scissors"].includes(String(computer)));
      if (player === computer) expected.ties++;
      else if (
        ({ rock: "scissors", paper: "rock", scissors: "paper" } as Record<string, string>)[
          player
        ] === computer
      )
        expected.wins++;
      else expected.losses++;
    }
    assert.deepEqual(actual.value, expected);
    for (const q of actual.questions)
      assert.deepEqual([...(q.suggestions ?? [])].sort(), ["paper", "rock", "scissors"]);
  }
  const stops = [];
  for (const action of ["decline", "cancel"] as const) {
    const result = await execute(language, source, [], action);
    assert.deepEqual(result.value, { status: action });
    stops.push(action);
  }
  return { ...actual, stops };
}
