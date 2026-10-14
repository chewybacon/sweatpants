import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { run } from "effection";
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
  type AuthorityScenarioDriver,
} from "@sweatpants/journal-authority/testing";
import { ask } from "../../../apps/yo-tisyn/src/workflow/tools/ask.ts";
import { scheme } from "../runner.ts";
import { createSchemeDriver, SchemeEvaluationPort, encode, type Machine } from "../evaluation.ts";

const require = createRequire(import.meta.url);
const { Scheme } = require("../runtime/reflect-restricted.cjs") as {
  Scheme: { load_main(path: string, options: { reflect_wasm_dir: string }): Promise<Machine> };
};
const load = () =>
  Scheme.load_main(fileURLToPath(new URL("../runtime/journal.wasm", import.meta.url)), {
    reflect_wasm_dir: fileURLToPath(new URL("../runtime", import.meta.url)),
  });

for (const action of ["accept", "decline", "cancel"] as const)
  test(`real journal restores Scheme in fresh WASM: ${action}`, async (t) => {
    let draws = 0;
    const original = crypto.getRandomValues.bind(crypto);
    t.mock.method(crypto, "getRandomValues", (array: Uint32Array) => {
      draws++;
      return original(array);
    });
    const source = `(let-syntax ((ask! (syntax-rules () ((_ prompt)
    (effect "ask" (object (cons "message" prompt)))))))
    (let ((choice (effect "random" (object (cons "choices" (array "rock" "paper" "scissors"))))))
      (let ((answer (ask! "Your name?")))
        (if (equal? (field answer "action") "accept")
          (object (cons "choice" choice) (cons "answer" answer)
                  (cons "misc" (array (json-null) #f 0 "")))
          answer))))`;
    const tools = [scheme, ask];
    const registry = createDurableToolRegistry(tools);
    const attach = {
      sessionId: "hoot-journal",
      taskId: "turn-0/root",
      executionEpoch: 1,
      program: {
        id: scheme.manifest.programId,
        version: scheme.manifest.version,
        digest: scheme.manifest.digest,
      },
      input: { source },
      route: { driverKind: "program" },
    };
    const options = {
      journalId: "hoot-spike",
      journalIncarnation: "test-1",
      keyring: createCapabilityKeyring("hoot-tests", [
        { keyId: "test", secret: "hoot-journal-spike-test-secret-not-production" },
      ]),
      schemaRegistry: createDurableSchemaRegistry(
        tools.flatMap((tool) => [...tool.artifacts.catalog]),
      ),
    };
    let instances = 0;
    const live = new Set<string>();
    function* advance(authority: AuthorityScenarioDriver) {
      return yield* ProgramDriverRegistryContext.with(
        createProgramDriverRegistry([["program", createWorkflowProgramDriver(registry)]]),
        function* () {
          return yield* withProgramDriverTestScope(authority, function* () {
            yield* SchemeEvaluationPort.installDriver(
              createSchemeDriver(async () => {
                instances++;
                return load();
              }),
            );
            yield* SchemeEvaluationPort.api.around({
              *open(args, next) {
                const handle = yield* next(...args);
                live.add(handle);
                return handle;
              },
              *close([handle], next) {
                yield* next(handle);
                live.delete(handle);
              },
            });
            return yield* driveInstalledTestProgramTree({ attach });
          });
        },
      );
    }
    const parked = await run(function* () {
      const authority = yield* createAuthorityScenarioDriver(options);
      yield* authority.openTask({
        ...attach,
        turnId: "turn-0",
        manifest: scheme.manifest,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-host",
      });
      assert.equal((yield* advance(authority)).state, "parked");
      assert.equal(live.size, 0);
      const accepted = authority.readJournal(attach.sessionId);
      const pending = accepted.find(
        (record) =>
          record.payload.type === "PullRequested" && record.payload.descriptor.kind === "elicit",
      )?.payload;
      assert.ok(pending?.type === "PullRequested");
      assert.equal(pending.descriptor.kind, "elicit");
      assert.ok(draws > 0);
      const random = accepted.find(
        (record) =>
          record.payload.type === "PullRequested" &&
          record.payload.descriptor.kind === "record" &&
          record.payload.descriptor.key.startsWith("tisyn.random/v2:"),
      )?.payload;
      assert.ok(random?.type === "PullRequested");
      const result = accepted.find(
        (record) =>
          record.payload.type === "PullResolved" && record.payload.pullId === random.pullId,
      )?.payload;
      assert.ok(result?.type === "PullResolved");
      return {
        snapshot: JSON.parse(JSON.stringify(authority.exportSnapshot())),
        accepted,
        pending,
        result,
        draws,
        instances,
      };
    });
    // These are two independent Effection scopes, with a serialized authority snapshot between them.
    await run(function* () {
      const authority = yield* createAuthorityScenarioDriver({
        ...options,
        snapshot: parked.snapshot,
      });
      // Even a still-pending recovery must replay without entropy or live evaluator state.
      assert.equal((yield* advance(authority)).state, "parked");
      assert.equal(draws, parked.draws);
      assert.equal(live.size, 0);
      const reply = 'Ada "quoted" \\ newline\nλ😀 (effect "random" "inert")';
      const resolved = yield* authority.resolve({
        capability: authority.resolutionCapability(
          attach.sessionId,
          parked.pending.taskId,
          parked.pending.pullId,
        ),
        audience: "user:reply",
        outcome: {
          status: "ok",
          value: action === "accept" ? { action, content: { reply } } : { action },
        },
      });
      assert.notEqual(resolved.status, "rejected");
      const completed = yield* advance(authority);
      assert.equal(completed.state, "completed");
      assert.ok(completed.state === "completed");
      if (action === "accept") {
        const value = completed.value as {
          choice: string;
          answer: { content: { reply: string }; exchange: { messages: unknown[] } };
          misc: unknown[];
        };
        assert.ok(["rock", "paper", "scissors"].includes(value.choice));
        assert.ok(parked.result.outcome.status === "ok");
        assert.equal(value.choice, parked.result.outcome.value);
        assert.equal(value.answer.content.reply, reply);
        assert.ok(value.answer.exchange.messages.length > 0);
        assert.deepEqual(value.misc, [null, false, 0, ""]);
      } else {
        assert.deepEqual(completed.value, { action });
      }
      assert.equal(draws, parked.draws);
      assert.ok(instances > parked.instances);
      assert.equal(live.size, 0);
      assert.deepEqual(
        authority.readJournal(attach.sessionId).slice(0, parked.accepted.length),
        parked.accepted,
      );
      const records = authority.readJournal(attach.sessionId);
      assert.equal(
        records.filter(
          (record) =>
            record.payload.type === "PullRequested" &&
            record.payload.descriptor.kind === "record" &&
            record.payload.descriptor.key.startsWith("tisyn.random/v2:"),
        ).length,
        1,
      );
      assert.ok(
        records.some((record) => JSON.stringify(record.payload) === JSON.stringify(parked.result)),
      );
    });
  });

test("bridge preserves JSON and closes on terminal, failure and fuel exhaustion", async () => {
  await run(function* () {
    const driver = createSchemeDriver(load);
    for (const [source, expected] of [
      ["(let loop () (loop))", /fuel exhausted/],
      ['(effect "ask" (lambda () 1))', /Expected JSON data/],
      ["1 2", /Scheme/],
      ['(effect "ask" (object (cons "__proto__" 1)))', /prototype key/],
      ['(effect "ask" (object (cons "same" 1) (cons "same" 2)))', /Invalid JSON key/],
    ] as const) {
      const handle = yield* driver.open(source);
      let failed = false;
      try {
        yield* driver.advance(handle);
      } catch (error) {
        assert.match(String(error), expected);
        failed = true;
      }
      assert.equal(failed, true, source);
      assert.throws(() => driver.advance(handle)[Symbol.iterator]().next(), /closed/);
      yield* driver.close(handle);
    }
    const handle = yield* driver.open('(effect "ask" (object (cons "message" "JSON?")))');
    assert.deepEqual(yield* driver.advance(handle), {
      done: false,
      value: { id: "ask", data: { message: "JSON?" } },
    });
    const data = JSON.parse(
      '{"object":{"safe":true},"array":[null,false,0,1.25,1e-7,""],"text":"λ😀\\n\\u0000"}',
    );
    assert.deepEqual(yield* driver.advance(handle, data), { done: true, value: data });
    assert.throws(() => driver.advance(handle)[Symbol.iterator]().next(), /closed/);
    yield* driver.close(handle);
    const suspended = yield* driver.open(
      '(begin (effect "ask" (object (cons "message" "Go?"))) (let loop () (loop)))',
    );
    assert.equal((yield* driver.advance(suspended)).done, false);
    let exhausted = false;
    try {
      yield* driver.advance(suspended, null);
    } catch (error) {
      assert.match(String(error), /fuel exhausted/);
      exhausted = true;
    }
    assert.equal(exhausted, true);
    assert.throws(() => driver.advance(suspended)[Symbol.iterator]().next(), /closed/);
    const healthy = yield* driver.open("(+ 20 22)");
    assert.deepEqual(yield* driver.advance(healthy), { done: true, value: 42 });
  });
  assert.throws(() => encode(JSON.parse('{"__proto__":1}')), /prototype key/);
  assert.throws(() => encode(Number.MAX_SAFE_INTEGER + 1), /Unsafe/);
  assert.throws(() => encode("\ud800"), /surrogate/);
});
