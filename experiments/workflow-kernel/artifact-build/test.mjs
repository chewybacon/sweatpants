import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { hash, copy } from "../compiled-finally/journal.mjs";
import { loadBundle } from "./load.mjs";
import { encodeSchema, decodeSchema } from "./validators.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-bundle-"));
const sourcePath = path.join(dir, "workflow.ts"),
  bundlePath = path.join(dir, "bundle.json");
const here = (name) => new URL(name, import.meta.url).pathname;
let checks = 0;
const check = (fn) => {
  fn();
  checks++;
};
try {
  fs.copyFileSync(here("../tool-contracts/iteration-scope.ts"), sourcePath);
  const build = spawnSync(process.execPath, [here("./build.mjs"), sourcePath, bundlePath], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(build.status, 0, build.stderr);
  fs.unlinkSync(sourcePath);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  check(() => assert.ok(loadBundle(bundle).schemas));
  const tripwire = spawnSync(
    process.execPath,
    [
      "--import",
      here("./no-compiler.mjs"),
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(here("../tool-contracts/compiler.mjs"))})`,
    ],
    { encoding: "utf8" },
  );
  check(() => assert.match(tripwire.stderr, /Compiler loaded during recovery/));
  const pids = new Set();
  const fresh = (request) => {
    const r = spawnSync(
      process.execPath,
      ["--import", here("./no-compiler.mjs"), here("./runtime-worker.mjs")],
      { input: JSON.stringify({ bundlePath, ...request }), encoding: "utf8", timeout: 20000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.ok(!pids.has(result.pid));
    pids.add(result.pid);
    return result;
  };
  for (const mode of ["normal", "cancel-cleanup", "cleanup-error"]) {
    let r = fresh({ input: { count: 3 } }),
      n = 0;
    const trace = [];
    while (r.pending) {
      const key = r.pending.request[1];
      trace.push([key, r.pending.request[2].message]);
      if (mode === "cancel-cleanup" && key === "release") {
        const pending = r.pending.id;
        r = fresh({
          record: r.record,
          command: {
            id: "cancel",
            requestId: pending,
            revision: r.record.events.length,
            input: { cancel: true },
          },
        });
        check(() => assert.equal(r.pending.id, pending));
      }
      const input =
        key === "acquire"
          ? { reply: { action: "accept", content: { id: "hold-" + ++n } } }
          : mode === "cleanup-error"
            ? { error: "release failed" }
            : { reply: { action: "accept", content: "released" } };
      const command = {
        id: "reply-" + r.record.events.length,
        requestId: r.pending.id,
        revision: r.record.events.length,
        input,
      };
      const record = copy(r.record);
      delete record.checkpoint;
      const fromCheckpoint = fresh({ record: r.record, command });
      const fromReplay = fresh({ record, command });
      check(() => assert.deepEqual(fromCheckpoint.record, fromReplay.record));
      r = fromCheckpoint;
    }
    check(() =>
      assert.deepEqual(
        r.outcome,
        mode === "normal"
          ? { kind: "returned", value: 0 }
          : mode === "cleanup-error"
            ? { kind: "thrown", value: "release failed" }
            : { kind: "cancelled" },
      ),
    );
    check(() =>
      assert.deepEqual(
        trace,
        mode === "normal"
          ? Array.from({ length: 3 }, (_, i) => [
              ["acquire", "Reserve a hold"],
              ["release", "hold-" + (i + 1)],
            ]).flat()
          : [
              ["acquire", "Reserve a hold"],
              ["release", "hold-1"],
            ],
      ),
    );
    check(() => assert.deepEqual(fresh({ record: r.record }).record, r.record));
  }
  const altered = copy(bundle);
  altered.source += "tampered";
  check(() => assert.throws(() => loadBundle(altered), /integrity/));
  const validatorsChanged = copy(bundle);
  delete validatorsChanged.validators[Object.keys(validatorsChanged.validators)[0]];
  const { id, ...body } = validatorsChanged;
  validatorsChanged.id = hash(body);
  check(() => assert.throws(() => loadBundle(validatorsChanged), /identity/));
  const { z } = createRequire(
    new URL("../../../packages/vite-plugin/package.json", import.meta.url),
  )("zod");
  const schemas = [
    z.string().min(2).max(5),
    z.number().int().min(0).max(5),
    z.strictObject({ name: z.string(), count: z.number().optional() }),
    z.array(z.enum(["a", "b"])).min(1),
    z.union([z.literal("ok"), z.null()]),
    z.string().nullable(),
  ];
  const values = [
    null,
    false,
    0,
    1.5,
    6,
    "a",
    "ok",
    "toolong",
    [],
    ["a"],
    ["c"],
    { name: "x" },
    { name: "x", count: 2 },
    { name: "x", extra: 1 },
  ];
  for (const schema of schemas) {
    const restored = decodeSchema(encodeSchema(schema));
    for (const value of values) {
      check(() => assert.equal(restored.safeParse(value).success, schema.safeParse(value).success));
    }
  }
  for (const schema of [
    z.string().refine((x) => x === "x"),
    z.string().transform((x) => x.length),
    z.object({ name: z.string() }),
    z.coerce.number(),
  ]) {
    check(() => assert.throws(() => encodeSchema(schema)));
  }
  console.log(
    "PASS",
    checks,
    "bundle checks;",
    pids.size,
    "fresh runtime processes; source deleted and compiler imports blocked",
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
