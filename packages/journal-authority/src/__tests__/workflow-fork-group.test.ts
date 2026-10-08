import { call } from "effection";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  createDurableToolRegistry,
  createPinnedDurableProgram,
  ProgramDriverRegistryContext,
  createProgramDriverRegistry,
  stableProgramAttachmentId,
  type DurableProgramManifest,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import { assertJson } from "@sweatpants/foundation";
import {
  driveInstalledTestProgramTree,
  withProgramDriverTestScope,
} from "../testing/program-driver-host.ts";
import { createAuthorityScenarioDriver } from "../testing/testing.ts";
import { booleanGuard, createSchemaFixture, stringGuard } from "../testing/schema-fixtures.ts";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createDurableSchemaRegistry } from "../contract/schema-registry.ts";
import { createWorkflowProgramDriver } from "../workflow/program-driver.ts";

/**
 * Fork-group drives through the real Authority, ProgramDriver, and tree-drive
 * stack (test-plan TC-002 at workflow level; REQ-053's two-elicit behavior).
 */

const inputFixture = createSchemaFixture(
  "fixture.fork/input",
  "program_input",
  { type: "string" },
  stringGuard,
);
const outputFixture = createSchemaFixture(
  "fixture.fork/output",
  "program_output",
  { type: "string" },
  stringGuard,
);
const answerFixture = createSchemaFixture(
  "fixture.fork/answer",
  "elicit_response",
  { type: "boolean" },
  booleanGuard,
);
const schemaRegistry = () =>
  createDurableSchemaRegistry([inputFixture.entry, outputFixture.entry, answerFixture.entry]);
const keyring = createCapabilityKeyring("fork-tests", [{ keyId: "k1", secret: "x".repeat(32) }]);

function childManifest(id: string, digestChar: string): DurableProgramManifest {
  return {
    programId: id,
    version: "1.0.0",
    digest: digestChar.repeat(64),
    inputSchema: inputFixture.descriptor,
    outputSchema: outputFixture.descriptor,
    elicits: { answer: { response: answerFixture.descriptor } },
    effects: {},
    capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
  };
}

const parentManifest: DurableProgramManifest = {
  programId: "fixture.fork/parent",
  version: "1.0.0",
  digest: "f".repeat(64),
  inputSchema: inputFixture.descriptor,
  outputSchema: outputFixture.descriptor,
  elicits: {},
  effects: {},
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
};

function elicitingChild(id: string, digestChar: string) {
  return createPinnedDurableProgram(childManifest(id, digestChar), function* (input, context) {
    const answer = (yield* context.pull(
      assertJson({
        kind: "elicit",
        key: "answer",
        message: `${id} asks?`,
        response: answerFixture.descriptor,
      }),
    )) as { action: string };
    return `${input}:${answer.action}`;
  });
}

const childA = elicitingChild("fixture.fork/child-a", "a");
const childB = elicitingChild("fixture.fork/child-b", "b");

const childARef = {
  id: childA.manifest.programId,
  version: childA.manifest.version,
  digest: childA.manifest.digest,
  input: "A",
};
const childBRef = {
  id: childB.manifest.programId,
  version: childB.manifest.version,
  digest: childB.manifest.digest,
  input: "B",
};

const parentTool = createPinnedDurableProgram(parentManifest, function* (_input, context) {
  const terminal = (yield* context.pull(
    assertJson({
      kind: "all",
      supervision: "one_for_all",
      children: [childARef, childBRef],
      expiry: { kind: "after", durationMs: 60_000 },
    }),
  )) as {
    status: string;
    outcomes: { ordinal: number; outcome: { status: string; value?: string } }[];
  };
  if (terminal.status !== "completed") {
    throw new Error(`group ended ${terminal.status}`);
  }
  const values = terminal.outcomes.map((entry) => {
    if (entry.outcome.status !== "ok" || entry.outcome.value === undefined) {
      throw new Error("biography is not ok");
    }
    return entry.outcome.value;
  });
  return values.join("|");
});

function makeAuthority() {
  return createAuthorityScenarioDriver({
    journalId: "journal-fork",
    journalIncarnation: "incarnation-1",
    keyring,
    now: () => 1_000,
    schemaRegistry: schemaRegistry(),
  });
}

const sessionId = "fork-session";

function attachRequest(manifest: DurableProgramManifest = parentManifest) {
  return {
    sessionId,
    taskId: "turn-0/root",
    program: {
      id: manifest.programId,
      version: manifest.version,
      digest: manifest.digest,
    },
    input: "go",
    route: { driverKind: "program" as const },
    executionEpoch: 1,
  };
}

describe("fork groups through the workflow program driver", () => {
  it("mixed group: local members drive, peers resolve through evidence (REQ-037, REQ-075)", async () => {
    return await run(function* () {
      const peerProgram = createPinnedDurableProgram(
        childManifest("fixture.fork/peer-p", "7"),
        function* (input) {
          return `${input}:peer`;
        },
      );
      const peerRef = {
        id: peerProgram.manifest.programId,
        version: peerProgram.manifest.version,
        digest: peerProgram.manifest.digest,
        input: "P",
        durability: {
          kind: "peer_hosted" as const,
          peer: "peer-1",
          sampling: "delegated" as const,
        },
      };
      const mixedParent = createPinnedDurableProgram(
        { ...parentManifest, programId: "fixture.fork/mixed-parent", digest: "9".repeat(64) },
        function* (_input, context) {
          const terminal = (yield* context.pull(
            assertJson({
              kind: "all",
              supervision: "one_for_all",
              children: [childARef, peerRef],
              expiry: { kind: "after", durationMs: 60_000 },
            }),
          )) as {
            status: string;
            outcomes: { ordinal: number; outcome: { status: string; value?: string } }[];
          };
          if (terminal.status !== "completed") {
            throw new Error(`group ended ${terminal.status}`);
          }
          return terminal.outcomes.map((entry) => entry.outcome.value).join("|");
        },
      );

      const authority = yield* makeAuthority();
      const drivers = createProgramDriverRegistry([
        [
          "program",
          createWorkflowProgramDriver(
            createDurableToolRegistry([mixedParent, childA, peerProgram]),
          ),
        ],
      ]);
      const request = attachRequest(mixedParent.manifest);

      yield* call(() =>
        run(function* () {
          yield* withProgramDriverTestScope(authority, function* () {
            const opened = yield* authority.openTask({
              sessionId: request.sessionId,
              turnId: "turn-0",
              taskId: request.taskId,
              manifest: mixedParent.manifest,
              input: request.input,
              executionEpoch: 1,
              attachmentId: stableProgramAttachmentId(request),
              audience: "program-host",
            });
            void opened;
            const firstRun: AdvancementResult = yield* ProgramDriverRegistryContext.with(
              drivers,
              function* () {
                return yield* driveInstalledTestProgramTree({
                  attach: request,
                });
              },
            );
            if (firstRun.state !== "parked") {
              throw new Error(`expected parked, got ${firstRun.state}`);
            }
            // The peer member never surfaces a local slot; only the local elicit
            // is participant-addressable (REQ-028 + Invariant P).
            expect(firstRun.slots).toHaveLength(1);
            expect(firstRun.slots![0]).toMatchObject({ reason: "elicit" });

            const journal = authority.readJournal(sessionId);
            const openedRecord = journal.find((entry) => entry.payload.type === "ForkGroupOpened");
            if (openedRecord?.payload.type !== "ForkGroupOpened") {
              throw new Error("no group");
            }
            const peerTaskId = openedRecord.payload.memberTaskIds[1]!;

            // Journal-first delegation, then peer evidence under a CAS-issued mandate.
            const plan = yield* authority.query({ type: "forest.replay-plan", sessionId });
            const ready = plan.peers.find((candidate) => candidate.address.taskId === peerTaskId);
            if (ready === undefined) {
              throw new Error("peer target was not prepared");
            }
            const peerBound = yield* authority.command({
              type: "execution.bind-delivery-mandate",
              request: {
                ready,
                attachmentId: `peer-delivery:${peerTaskId}`,
                ownerId: "workflow-peer-test",
                leaseDurationMs: 30_000,
                placement: {
                  route: {
                    kind: "peer",
                    driverKind: "peer",
                    peer: "peer-1",
                    route: { driverKind: "peer" },
                  },
                  evaluatorKind: "peer",
                  sandbox: { mode: "allocate" },
                },
                expected: {
                  strandHeadDigest: ready.evidenceHead.digest,
                  leaseEpoch: ready.executionEpoch,
                  forkGroupRevision: ready.groupContext.groupRevision,
                },
              },
            });
            if (peerBound.status !== "bound") {
              throw new Error("peer bind was stale");
            }
            const delegation = yield* authority.commitPeerDelegation({
              mandate: peerBound.mandate,
            });
            yield* authority.commitPeerEvidence({
              mandate: peerBound.mandate,
              correlator: delegation.correlator,
              outcome: { status: "ok", value: "P:peer" },
            });

            // Settle the local member's elicit and re-drive.
            const slot = firstRun.slots![0]!;
            const validated = yield* authority.validateElicitResponse({
              sessionId,
              pullId: slot.pullId,
              participantId: "user:answer",
              completion: { action: "accept", content: true },
            });
            if (validated.status !== "valid") {
              throw new Error(`validation ${validated.status}`);
            }
            yield* authority.resolve({
              capability: authority.resolutionCapability(sessionId, slot.taskId, slot.pullId),
              audience: validated.audience,
              outcome: validated.outcome,
            });
            const bound = yield* authority.bindProgramAttachment(
              request.sessionId,
              request.taskId,
              stableProgramAttachmentId(request) + "-2",
              1,
            );
            void bound;
            const secondRun: AdvancementResult = yield* ProgramDriverRegistryContext.with(
              drivers,
              function* () {
                return yield* driveInstalledTestProgramTree({
                  attach: request,
                });
              },
            );
            if (secondRun.state !== "completed") {
              throw new Error(`expected completed, got ${secondRun.state}`);
            }
            expect(secondRun.value).toBe("A:accept|P:peer");

            // The peer member never accrued a local action — its strand is
            // structural evidence only (REQ-037).
            const snapshot = authority.exportSnapshot();
            const peerTask = snapshot.sessions[0]![1].execution.tasks.find(
              (task) => task.taskId === peerTaskId,
            );
            expect(peerTask?.actions).toHaveLength(0);
            expect(peerTask?.execution.audience).toBe("peer:peer-1");
          });
        }),
      );
    });
  });

  it("parks one elicit per member and resolves in descriptor order (REQ-053)", async () => {
    return await run(function* () {
      const authority = yield* makeAuthority();
      const drivers = createProgramDriverRegistry([
        [
          "program",
          createWorkflowProgramDriver(createDurableToolRegistry([parentTool, childA, childB])),
        ],
      ]);
      const request = attachRequest();

      yield* call(() =>
        run(function* () {
          yield* withProgramDriverTestScope(authority, function* () {
            const opened = yield* authority.openTask({
              sessionId: request.sessionId,
              turnId: "turn-0",
              taskId: request.taskId,
              manifest: parentManifest,
              input: request.input,
              executionEpoch: 1,
              attachmentId: stableProgramAttachmentId(request),
              audience: "program-host",
            });
            void opened;
            const activate = () =>
              ProgramDriverRegistryContext.with(drivers, function* () {
                return yield* driveInstalledTestProgramTree({ attach: request });
              });

            const firstRun: AdvancementResult = yield* activate();
            if (firstRun.state !== "parked") {
              throw new Error(`expected parked, got ${firstRun.state}`);
            }
            // Bounded frontier: both member elicits surface as slots.
            expect(firstRun.reason).toBe("child");
            expect(firstRun.slots).toHaveLength(2);
            const reasons = firstRun.slots!.map((slot) => slot.reason);
            expect(reasons).toEqual(["elicit", "elicit"]);

            // Settle each member's elicit against its own task.
            for (const slot of firstRun.slots!) {
              const validated = yield* authority.validateElicitResponse({
                sessionId,
                pullId: slot.pullId,
                participantId: "user:answer",
                completion: { action: "accept", content: true },
              });
              if (validated.status !== "valid") {
                throw new Error(`validation ${validated.status}`);
              }
              const resolved = yield* authority.resolve({
                capability: authority.resolutionCapability(sessionId, slot.taskId, slot.pullId),
                audience: validated.audience,
                outcome: validated.outcome,
              });
              if (resolved.status !== "accepted") {
                throw new Error(`resolve ${resolved.status}`);
              }
            }

            const secondRun: AdvancementResult = yield* activate();
            if (secondRun.state !== "completed") {
              throw new Error(`expected completed, got ${secondRun.state}`);
            }
            expect(secondRun.value).toBe("A:accept|B:accept");

            const types = authority.readJournal(sessionId).map((entry) => entry.payload.type);
            expect(types).toContain("ForkGroupOpened");
            expect(types).toContain("ForkGroupResolved");
            expect(types.filter((type) => type === "ForkGroupResolved")).toHaveLength(1);
          });
        }),
      );
    });
  });

  it("race: first committed winner resolves after the loser drains", async () => {
    return await run(function* () {
      const fastChild = createPinnedDurableProgram(
        childManifest("fixture.fork/fast", "d"),
        function* (input) {
          return `${input}:fast`;
        },
      );
      const fastChildRef = {
        id: fastChild.manifest.programId,
        version: fastChild.manifest.version,
        digest: fastChild.manifest.digest,
        input: "R",
      };
      const raceParent = createPinnedDurableProgram(
        { ...parentManifest, programId: "fixture.fork/race-parent", digest: "e".repeat(64) },
        function* (_input, context) {
          const terminal = (yield* context.pull(
            assertJson({
              kind: "race",
              supervision: "first_success",
              children: [fastChildRef, childARef],
              expiry: { kind: "after", durationMs: 60_000 },
            }),
          )) as {
            status: string;
            winnerOrdinal?: number;
            outcomes: { ordinal: number; outcome: { status: string; value?: string } }[];
          };
          if (terminal.status !== "completed") {
            throw new Error(`race ended ${terminal.status}`);
          }
          const winner = terminal.outcomes.find(
            (entry) => entry.ordinal === terminal.winnerOrdinal,
          );
          return winner?.outcome.status === "ok" ? winner.outcome.value! : "no-winner";
        },
      );

      const authority = yield* makeAuthority();
      const drivers = createProgramDriverRegistry([
        [
          "program",
          createWorkflowProgramDriver(createDurableToolRegistry([raceParent, fastChild, childA])),
        ],
      ]);
      const request = attachRequest(raceParent.manifest);

      yield* call(() =>
        run(function* () {
          yield* withProgramDriverTestScope(authority, function* () {
            yield* authority.openTask({
              sessionId: request.sessionId,
              turnId: "turn-0",
              taskId: request.taskId,
              manifest: raceParent.manifest,
              input: request.input,
              executionEpoch: 1,
              attachmentId: stableProgramAttachmentId(request),
              audience: "program-host",
            });
            const result: AdvancementResult = yield* ProgramDriverRegistryContext.with(
              drivers,
              function* () {
                return yield* driveInstalledTestProgramTree({ attach: request });
              },
            );
            // The fast member wins in the first pass; the slow member's open
            // elicit is cancelled and drains inside the same drive.
            if (result.state !== "completed") {
              throw new Error(`expected completed, got ${result.state}`);
            }
            expect(result.value).toBe("R:fast");

            const journal = authority.readJournal(sessionId);
            const types = journal.map((entry) => entry.payload.type);
            expect(types).toContain("RaceWinnerSelected");
            expect(types).toContain("ForkGroupResolved");
            // Loser ends terminal(cancelled); the cancellation commits before the
            // group resolution (REQ-032/REQ-033 ordering).
            const cancelIndex = types.indexOf("CancellationRequested");
            const resolvedIndex = types.indexOf("ForkGroupResolved");
            expect(cancelIndex).toBeGreaterThan(-1);
            expect(resolvedIndex).toBeGreaterThan(cancelIndex);
          });
        }),
      );
    });
  });
});
