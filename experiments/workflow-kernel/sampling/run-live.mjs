// Manual live integration; never imported by the ordinary acceptance runner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { createRuntime } from "../../../packages/v2/runtime-effection/src/index.ts";
import { createSchemeKernel } from "../../../packages/v2/codemode-runtime-scheme/src/index.ts";
import {
  loadSchemeMachine,
  schemeRuntimeIdentity,
} from "../../../packages/v2/codemode-runtime-scheme/src/node.ts";
import {
  createPiAiProvider,
  describePiAiModel,
} from "../../../packages/v2/providers-pi-ai/src/index.ts";
import { createSqliteJournalStore } from "../../../packages/v2/storage-sqlite/src/index.ts";
import {
  createNodeSqliteConnection,
  v8Serializer,
} from "../../../packages/v2/storage-sqlite/src/node.ts";
import { gameCaller } from "./game.mts";
import { bindSamplingProgram } from "./scheme.mts";
import { createSamplingHost } from "./hosting.mts";
import { sample } from "./contracts.mts";

const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) {
  throw new Error("Configure the existing server-only CLI proxy credential and endpoint");
}
const catalog = builtinModels();
const openai = openaiProvider();
const baseUrl = process.env.OPENAI_BASE_URL;
catalog.setProvider({
  ...openai,
  baseUrl,
  getModels: () => openai.getModels().map((model) => ({ ...model, baseUrl })),
  getAllModels: () =>
    (openai.getAllModels?.() ?? openai.getModels()).map((model) => ({ ...model, baseUrl })),
});
const selected = catalog.getModel("openai", process.env.CHAT_MODEL ?? "gpt-6-luna");
const info = describePiAiModel(selected);
const model = { id: info.id, provider: info.provider, api: info.api };
const runtime = createRuntime();
let providerCalls = 0;
const provider = createPiAiProvider(runtime, {
  model: selected,
  apiKey: process.env.OPENAI_API_KEY,
  stream(model, context, options) {
    providerCalls++;
    return catalog.streamSimple(model, context, options);
  },
});
const artifact = bindSamplingProgram(gameCaller, schemeRuntimeIdentity, model);
const directory = mkdtempSync(join(tmpdir(), "sweatpants-sampling-"));
const path = join(directory, "game.sqlite");
let db = new DatabaseSync(path);
const journal = () =>
  createSqliteJournalStore({
    id: "live-game",
    program: artifact.program,
    equals: isDeepStrictEqual,
    connection: createNodeSqliteConnection(db),
    serialization: {
      *resolve() {
        return v8Serializer;
      },
    },
  }).open();
const kernel = createSchemeKernel(runtime, {
  identity: schemeRuntimeIdentity,
  loadMachine: loadSchemeMachine,
  decodeRequest: artifact.decodeRequest,
  decodeResult: (value) => value,
});
const run = (command) =>
  runtime.start(() =>
    createSamplingHost(runtime, {
      program: artifact.program,
      journal: journal(),
      model,
      provider,
      prepare: () => kernel.prepare(artifact.source, 2),
    }).run(command),
  ).result;
function reopen() {
  db.close();
  db = new DatabaseSync(path);
}
try {
  const first = await run();
  assert.equal(first.state, "waiting");
  assert.equal(providerCalls, 1);
  reopen();
  assert.deepEqual(await run(), first);
  assert.equal(providerCalls, 1);
  const second = await run({ grant: first.grant, value: "paper" });
  assert.equal(second.state, "waiting");
  assert.equal(providerCalls, 2);
  reopen();
  const final = await run({ grant: second.grant, value: "rock" });
  assert.equal(final.state, "completed");
  assert.match(final.value, /^(tie|player|model);(tie|player|model);$/);
  assert.equal(providerCalls, 2);
  const history = await runtime.start(function* () {
    const snapshot = yield* journal().read();
    return yield* snapshot.history.read(0, 10);
  }).result;
  const accepted = history.filter((entry) => entry.request.effect === sample.id);
  assert.equal(accepted.length, 2);
  console.log(
    JSON.stringify(
      {
        model,
        providerCalls,
        result: final,
        acceptedSamples: accepted.map((entry) => entry.outcome),
      },
      null,
      2,
    ),
  );
  console.log(
    "Live sandbox sampling: two provider requests, two explicit scripted player replies, SQLite reopen without resampling — passed.",
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
