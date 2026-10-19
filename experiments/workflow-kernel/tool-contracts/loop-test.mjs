import fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { compileToolDefinition } from "./compiler.mjs";
import { create, recover, appendCommand, repair, copy } from "../compiled-finally/journal.mjs";
import { inspect } from "../compiled-frames/compiler.mjs";
const source = fs.readFileSync(new URL("./loop.ts", import.meta.url), "utf8");
const { artifact: a, schemas, tool } = compileToolDefinition(source),
  registry = { [a.id]: a };
let checks = 0;
const accept = { action: "accept", content: "ok" };
for (const [name, limit, moves, expected] of [
  ["empty", 0, [], { rounds: 0, score: 0 }],
  [
    "break-and-continue",
    10,
    [accept, { action: "cancel" }, { action: "decline" }],
    { rounds: 3, score: 1 },
  ],
  ["exhaustion", 2, [accept, accept], { rounds: 2, score: 2 }],
]) {
  let record = create(a, name, schemas, { limit });
  const native = tool.program(
    { limit },
    {
      pull: function* (request) {
        return yield request;
      },
    },
  );
  let step = native.next(),
    move = 0;
  while (!step.done) {
    const ctx = recover(record, registry, schemas);
    assert.equal(ctx.pending.request[1], step.value.key);
    assert.equal(ctx.pending.request[2].message, step.value.message);
    const view = inspect(a.compiled, ctx.state);
    const line = view.source.line;
    assert.ok(
      source.split("\n")[line - 1].slice(view.source.column).startsWith("yield* ctx.elicit"),
      `Original source location: ${line}:${view.source.column}`,
    );
    const reply = step.value.key === "move" ? moves[move++] : accept;
    assert.ok(reply);
    const accepted = appendCommand(
      record,
      registry,
      {
        id: `reply-${record.events.length}`,
        requestId: ctx.pending.id,
        input: { reply },
        revision: record.events.length,
      },
      schemas,
    );
    const replay = copy(accepted);
    delete replay.checkpoint;
    assert.deepEqual(repair(replay, registry, schemas), repair(accepted, registry, schemas));
    const child = spawnSync(
      process.execPath,
      [new URL("./test.mjs", import.meta.url).pathname, "resume"],
      {
        input: JSON.stringify({ source, record: accepted }),
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    record = JSON.parse(child.stdout);
    assert.deepEqual(record, repair(accepted, registry, schemas));
    step = native.next(reply);
    checks++;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(step.value)), expected);
  assert.deepEqual(record.events.at(-1).outcome, { kind: "returned", value: expected });
  checks++;
}
// External cancellation must run the suspended turn's cleanup, then stop.
let stopped = create(a, "cancel", schemas, { limit: 10 });
let ctx = recover(stopped, registry, schemas);
stopped = repair(
  appendCommand(
    stopped,
    registry,
    {
      id: "cancel",
      requestId: ctx.pending.id,
      input: { cancel: true },
      revision: stopped.events.length,
    },
    schemas,
  ),
  registry,
  schemas,
);
ctx = recover(stopped, registry, schemas);
assert.equal(ctx.pending.request[1], "cleanup");
checks++;
stopped = appendCommand(
  stopped,
  registry,
  {
    id: "cleanup",
    requestId: ctx.pending.id,
    input: { reply: accept },
    revision: stopped.events.length,
  },
  schemas,
);
const replay = copy(stopped);
delete replay.checkpoint;
stopped = repair(stopped, registry, schemas);
assert.deepEqual(repair(replay, registry, schemas), stopped);
assert.deepEqual(stopped.events.at(-1).outcome, { kind: "cancelled" });
checks++;
fs.writeFileSync(
  new URL("./loop-results.json", import.meta.url),
  JSON.stringify(
    {
      checks,
      originalSourceLocations: true,
      limitations: [
        "Unlabeled while/break/continue only",
        "No shadowed bindings or environment reclamation",
        "No production integration",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log("PASS", checks, "loop and recovery checks");
