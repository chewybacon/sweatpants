import fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { compileToolDefinition } from "./compiler.mjs";
import { create, recover, appendCommand, repair, copy } from "../compiled-finally/journal.mjs";
import { inspect } from "../compiled-frames/compiler.mjs";
const source = fs.readFileSync(new URL("./helpers.ts", import.meta.url), "utf8");
const { artifact: a, schemas, tool } = compileToolDefinition(source),
  registry = { [a.id]: a };
let checks = 0,
  record = create(a, "helpers", schemas, { traveler: "Ada" });
const first = recover(record, registry, schemas);
const firstView = inspect(a.compiled, first.state);
assert.deepEqual(
  firstView.frames.map((f) => f.function),
  ["workflow", "book", "pickSeat"],
);
assert.equal(firstView.frames.at(-1).locals.traveler, "Ada");
assert.equal(firstView.source.function, "pickSeat");
checks++;
assert.equal(a.tool.elicits[first.state.site].key, "pick");
checks++;
const responses = [
  { action: "accept", content: { seat: "aisle" } },
  { action: "accept", content: { confirmed: true } },
];
const native = tool.program(
  { traveler: "Ada" },
  {
    pull: function* (request) {
      return yield request;
    },
  },
);
let next = native.next();
for (const [index, reply] of responses.entries()) {
  const ctx = recover(record, registry, schemas);
  assert.equal(ctx.pending.request[1], next.value.key);
  assert.equal(ctx.pending.request[2].message, next.value.message);
  checks++;
  if (index === 1) {
    const view = inspect(a.compiled, ctx.state);
    assert.deepEqual(
      view.frames.map((f) => f.function),
      ["workflow", "book"],
    );
    assert.deepEqual(view.frames.at(-1).locals.selected, {
      traveler: "Ada",
      selection: responses[0],
    });
    checks++;
  }
  const accepted = appendCommand(
    record,
    registry,
    {
      id: `reply-${index}`,
      requestId: ctx.pending.id,
      input: { reply },
      revision: record.events.length,
    },
    schemas,
  );
  const replay = copy(accepted);
  delete replay.checkpoint;
  for (const saved of [accepted, replay]) {
    const child = spawnSync(
      process.execPath,
      [new URL("./test.mjs", import.meta.url).pathname, "resume"],
      { input: JSON.stringify({ source, record: saved }), encoding: "utf8", timeout: 20000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), repair(accepted, registry, schemas));
    checks++;
  }
  record = repair(accepted, registry, schemas);
  next = native.next(reply);
}
assert.equal(next.done, true);
assert.deepEqual(record.events.at(-1).outcome, {
  kind: "returned",
  value: JSON.parse(JSON.stringify(next.value)),
});
checks++;
const finalReplay = copy(record);
delete finalReplay.checkpoint;
assert.deepEqual(repair(finalReplay, registry, schemas), record);
checks++;
assert.throws(
  () => compileToolDefinition(source.replace('  "use workflow";', '  "ordinary";')),
  /Expected named function/,
);
checks++;
assert.throws(
  () => compileToolDefinition(source.replace("pickSeat(ctx, traveler)", "pickSeat(ctx, 42)")),
  (e) => e.code === "workflow_typecheck_failed",
);
checks++;
// Module captures cannot silently become missing values in a recovered helper.
assert.throws(
  () =>
    compileToolDefinition(
      'const greeting = "Hello";\n' +
        source.replace("{ message: traveler }", "{ message: greeting }"),
    ),
  /Unbound local greeting/,
);
checks++;
// Exceptions from delegated helpers unwind through the parent unchanged.
const throwingSource =
  "import type {Operation} from 'effection';\n" +
  source
    .replace(
      "function* pickSeat(ctx: Context, traveler: string) {",
      'function* pickSeat(ctx: Context, traveler: string): Operation<{traveler:string;selection:{action:"cancel"}}> {',
    )
    .replace("return { traveler, selection };", 'throw "seat selection failed";');
// The caller needs a compatible static type even though this helper never returns.
const throwing = compileToolDefinition(throwingSource);
let thrownRecord = create(throwing.artifact, "helper-error", throwing.schemas, { traveler: "Ada" });
const thrownRegistry = { [throwing.artifact.id]: throwing.artifact };
const pending = recover(thrownRecord, thrownRegistry, throwing.schemas).pending;
thrownRecord = appendCommand(
  thrownRecord,
  thrownRegistry,
  {
    id: "reply",
    requestId: pending.id,
    input: { reply: responses[0] },
    revision: thrownRecord.events.length,
  },
  throwing.schemas,
);
const thrownReplay = copy(thrownRecord);
delete thrownReplay.checkpoint;
const thrownFinal = repair(thrownReplay, thrownRegistry, throwing.schemas);
assert.deepEqual(thrownFinal.events.at(-1).outcome, {
  kind: "thrown",
  value: "seat selection failed",
});
checks++;
fs.writeFileSync(
  new URL("./helpers-results.json", import.meta.url),
  JSON.stringify(
    {
      checks,
      firstView,
      outcome: record.events.at(-1).outcome,
      limitations: [
        "Same-module named helpers only, each with use workflow and ctx first",
        "No captured module values or imported helper compilation",
        "Debugger effect locations refer to authored TypeScript source",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log("PASS", checks, "compiled helper checks");
