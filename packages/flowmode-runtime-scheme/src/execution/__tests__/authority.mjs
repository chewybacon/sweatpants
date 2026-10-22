import { lifecycleEvents } from "./fixtures/lifecycle.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHootDriver, manifest } from "./fixtures/fixture-driver.mjs";
import {
  createStoredScenarioDriver,
  driveTestProgramTree,
} from "@sweatpants/journal-authority/testing";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { createCapabilityKeyring } from "@sweatpants/journal-authority";
import { ProgramDriverRegistryContext } from "@sweatpants/durable-execution";
const { run } = createRequire(new URL("../../../../../package.json", import.meta.url))("effection");
for (const cancel of [false, true]) {
  await run(function* () {
    const store = createMemoryExecutionStore();
    const options = {
      journalId: "hoot-proof",
      keyring: createCapabilityKeyring("proof", [{ keyId: "key", secret: "x".repeat(32) }]),
    };
    let authority = yield* createStoredScenarioDriver(store, options);
    const attach = {
      sessionId: "session",
      taskId: "turn-0/root",
      program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
      input: null,
      route: { driverKind: "hoot-composition" },
      executionEpoch: 1,
    };
    yield* authority.openTask({
      ...attach,
      turnId: "turn-0",
      manifest,
      attachmentId: "unattached",
      audience: "fixture",
    });
    const events = [],
      seen = [];
    let cancelled = false,
      finished = false;
    for (let i = 0; i < 5; i++) {
      const driver = createHootDriver(lifecycleEvents(events));
      const result = yield* ProgramDriverRegistryContext.with(
        new Map([["hoot-composition", driver]]),
        function* () {
          return yield* driveTestProgramTree(
            {
              command: authority.advance.bind(authority),
              query: authority.query.bind(authority),
            },
            { attach },
          );
        },
      );
      if (result.state !== "parked") {
        assert.deepEqual(
          result,
          cancel
            ? { state: "cancelled" }
            : { state: "completed", value: "Caller received: approved" },
        );
        finished = true;
        break;
      }
      const records = yield* authority.readJournal(attach.sessionId);
      const pull = records.find(
        (r) => r.payload.type === "PullRequested" && r.payload.pullId === result.pullId,
      ).payload;
      seen.push(pull.descriptor.key);
      const stored = yield* authority.exportSnapshot();
      const checkpoint = stored.sessions[0][1].execution.tasks[0].execution.checkpoint;
      assert.equal(checkpoint.kind, "continuation");
      if (pull.descriptor.key === "approve") {
        assert.ok(JSON.stringify(checkpoint).includes("hold-17"));
        assert.ok(JSON.stringify(checkpoint).includes("Caller received: "));
      }
      if (cancel && !cancelled && pull.descriptor.key === "approve") {
        yield* authority.requestCancellation(
          attach.sessionId,
          attach.taskId,
          "cancel test",
          "cancel-1",
        );
        cancelled = true;
      } else {
        const capability = yield* authority.resolutionCapability(
          attach.sessionId,
          attach.taskId,
          result.pullId,
        );
        const content =
          pull.descriptor.key === "reserve"
            ? "hold-17"
            : pull.descriptor.key === "approve"
              ? "approved"
              : "released";
        const accepted = yield* authority.resolve({
          capability,
          audience: "user:" + pull.descriptor.key,
          outcome: { status: "ok", value: { action: "accept", content } },
        });
        assert.notEqual(accepted.status, "rejected");
      }
      authority = yield* createStoredScenarioDriver(store, options);
    }
    assert.equal(finished, true);
    assert.deepEqual(seen, ["reserve", "approve", "release"]);
    assert.equal(events.filter((e) => e === "start").length, 1);
    assert.equal(events.filter((e) => e === "restore").length, 3);
    assert.equal(events.filter((e) => e === "dispose").length, 4);
    assert.equal(events.filter((e) => e === "cancel").length, cancel ? 1 : 0);
    console.log("PASS stored authority + fresh Hoot instances", { cancel, seen, events });
  });
}
