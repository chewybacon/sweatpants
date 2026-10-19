import fs from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { create, recover, appendCommand, repair, copy } from "./journal.mjs";
import { artifact } from "./artifact.mjs";
const source = fs.readFileSync(new URL("./capture.ts", import.meta.url), "utf8");
if (process.argv[2] === "repair") {
  const { record, source } = JSON.parse(fs.readFileSync(0, "utf8"));
  const a = artifact(source);
  console.log(JSON.stringify(repair(record, { [a.id]: a })));
} else {
  const { run, ensure, action } = createRequire(new URL("../../../package.json", import.meta.url))(
    "effection",
  );
  let checks = 0;
  const results = [];
  for (const mode of ["normal", "cancel", "cancel-mid", "cleanup-error", "continue", "break"]) {
    const code =
      mode === "continue"
        ? source.replace(
            "    remaining = remaining - 1;",
            "    remaining = remaining - 1;\n    continue;",
          )
        : mode === "break"
          ? source.replace(
              "    remaining = remaining - 1;",
              "    remaining = remaining - 1;\n    if (remaining === 1) break;",
            )
          : source;
    const a = artifact(code),
      registry = { [a.id]: a };
    let record = create(a, mode),
      holds = 0;
    const trace = [];
    while (recover(record, registry).pending) {
      const ctx = recover(record, registry),
        request = ctx.pending.request;
      trace.push(request);
      if (request[1] === "ready") {
        const registrations = ctx.state.scopes[0].cleanups;
        assert.equal(new Set(registrations.map((c) => c.env)).size, holds);
        assert.deepEqual(
          registrations.map((c) => ctx.state.heap[c.env].bindings.hold),
          Array.from({ length: holds }, (_, i) => `hold-${i + 1}`),
        );
        assert.equal(new Set(registrations.map((c) => ctx.state.heap[c.env].parent)).size, 1);
        checks++;
        fs.writeFileSync(
          new URL("./capture-checkpoint.json", import.meta.url),
          JSON.stringify(record, null, 2),
        );
      }
      let input = { reply: "released" };
      if (request[1] === "acquire") {
        input =
          mode === "cancel-mid" && holds === 2 ? { cancel: true } : { reply: `hold-${++holds}` };
      }
      if (request[1] === "ready" && mode === "cancel") {
        input = { cancel: true };
      }
      if (request[1] === "hold-3" && mode === "cleanup-error") {
        input = { error: "release failed" };
      }
      const accepted = appendCommand(record, registry, {
        id: `step-${record.events.length}`,
        requestId: ctx.pending.id,
        input,
        revision: record.events.length,
      });
      const replay = copy(accepted);
      delete replay.checkpoint;
      assert.deepEqual(repair(replay, registry), repair(accepted, registry));
      const child = spawnSync(
        process.execPath,
        [new URL("./capture-test.mjs", import.meta.url).pathname, "repair"],
        {
          input: JSON.stringify({ source: code, record: accepted }),
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(child.status, 0, child.stderr);
      record = JSON.parse(child.stdout);
      assert.deepEqual(record, repair(accepted, registry));
      checks++;
    }
    const cleanup = trace.filter((r) => r[1].startsWith("hold-"));
    assert.deepEqual(
      cleanup,
      Array.from({ length: holds }, (_, i) => [
        "elicit",
        `hold-${holds - i}`,
        mode === "break" || mode === "cancel-mid" ? 1 : 0,
        1,
      ]),
    );
    checks++;
    const outcome = record.events.at(-1).outcome;
    if (mode === "cancel" || mode === "cancel-mid") {
      assert.deepEqual(outcome, { kind: "cancelled" });
    } else {
      const nativeTrace = [];
      let nativeHolds = 0;
      const workflow = vm.runInNewContext(
        code.replace("import { ensure } from 'effection';", "") + "\nworkflow",
        { ensure },
      );
      const ctx = {
        elicit: function* (...args) {
          nativeTrace.push(["elicit", ...args]);
          return yield* action((resolve, reject) => {
            queueMicrotask(() =>
              args[0] === "hold-3" && mode === "cleanup-error"
                ? reject("release failed")
                : resolve(args[0] === "acquire" ? `hold-${++nativeHolds}` : "released"),
            );
            return () => {};
          });
        },
      };
      let nativeOutcome;
      try {
        nativeOutcome = { kind: "returned", value: await run(() => workflow(ctx)) };
      } catch (value) {
        nativeOutcome = { kind: "thrown", value };
      }
      assert.deepEqual(outcome, nativeOutcome);
      assert.deepEqual(trace, nativeTrace);
      checks++;
    }
    results.push({ mode, outcome, cleanup });
  }
  fs.writeFileSync(
    new URL("./capture-results.json", import.meta.url),
    JSON.stringify({ checks, results }, null, 2) + "\n",
  );
  console.log("PASS", checks, "captured environment checks");
}
