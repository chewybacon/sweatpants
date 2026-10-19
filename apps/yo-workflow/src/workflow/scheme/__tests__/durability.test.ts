import assert from "node:assert/strict";
import { it as test, vi, afterEach } from "vitest";
afterEach(() => vi.restoreAllMocks());
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
import { ask } from "../../tools/ask.ts";
import { createSchemeTool } from "../tool.ts";
const scheme = createSchemeTool([ask]);
import { SchemeEvaluationPort } from "@sweatpants/scheme-runtime";
import { createNodeSchemeDriver } from "@sweatpants/scheme-runtime/node";

for (const { child, action, fault } of [
  ...[false, true].flatMap((child) =>
    (["accept", "decline", "cancel"] as const).map((action) => ({ child, action, fault: false })),
  ),
  { child: false, action: "accept", fault: true },
]) {
  test(`real journal restores Scheme in fresh WASM: ${action}, child=${child}, fault=${fault}`, async () => {
    let draws = 0;
    const original = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      draws++;
      return original(array);
    });
    const body = `(let-syntax ((ask! (syntax-rules () ((_ prompt)
    (effect "ask" (object (cons "message" prompt)))))))
    (let ((choice (effect "random" (object (cons "choices" (array "rock" "paper" "scissors"))))))
      (match-result (ask! "Your name?") "action"
        ("accept" answer
          (object (cons "choice" choice) (cons "answer" answer)
                  (cons "misc" (array (json-null) #f 0 ""))))
        (else answer answer))))`;
    const source = fault
      ? `(begin ${body} (field 1 "invalid"))`
      : child
        ? `(invoke '${body} (json-null))`
        : body;
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
      input: { program: source },
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
            yield* SchemeEvaluationPort.installDriver(createNodeSchemeDriver());
            yield* SchemeEvaluationPort.api.around({
              *open(args, next) {
                const handle = yield* next(...args);
                instances++;
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
      if (fault) {
        const value = completed.value as {
          status: string;
          completedEffects: number;
          recovery: { acceptedExchanges: unknown[]; omittedExchanges: number };
        };
        assert.equal(value.status, "failed");
        assert.equal(value.completedEffects, 2);
        assert.equal(value.recovery.omittedExchanges, 0);
        assert.equal(value.recovery.acceptedExchanges.length, 1);
        assert.ok(JSON.stringify(value.recovery.acceptedExchanges).includes("Ada"));
      } else if (action === "accept") {
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
}
