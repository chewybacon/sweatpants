import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { canonicalDigest } from "@sweatpants/foundation";
import { run } from "effection";
import { expect, it } from "vitest";
import { createCapabilityKeyring } from "../contract/capabilities.ts";
import { createStoredShellDrivers } from "../shell/stored-shell.ts";
import { createMemoryExecutionStore } from "../store/memory.ts";
import { DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES } from "../store/snapshot-codec.ts";
import type { ExecutionStore, StoredExecutionObject } from "../store/store.ts";

it("publishes one UUID snapshot across a CAS retry and reuses it after cold reload", async () => {
  const store = createMemoryExecutionStore();
  const staged: StoredExecutionObject[] = [];
  const proposedIds: string[] = [];
  let commits = 0;
  const measured: ExecutionStore = {
    ...store,
    *putObject() {
      throw new Error("Snapshots must be published inside the fenced commit");
    },
    *commitExecution(request) {
      proposedIds.push(request.objects![0]!.objectId);
      if (commits++ === 0) {
        expect(yield* store.getObject({ objectId: proposedIds[0]! })).toBeNull();
        return { status: "control_conflict", current: null };
      }
      const result = yield* store.commitExecution(request);
      if (result.status === "committed") staged.push(...(request.objects ?? []));
      return result;
    },
  };
  const options = {
    journalId: "snapshot-identities",
    now: () => 1000,
    keyring: createCapabilityKeyring("test", [
      { keyId: "test", secret: "test-secret-material-at-least-32-bytes" },
    ]),
  };
  const request = {
    sessionId: "session",
    turnId: "turn",
    taskId: "root",
    manifest: {
      programId: "snapshot-identity",
      version: "1",
      digest: "a".repeat(64),
      inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
      elicits: {},
      effects: {},
      capabilities: {
        durableEmissions: true,
        structuredChildren: false,
        replay: "strict" as const,
      },
    },
    input: null,
    executionEpoch: 1,
    attachmentId: "attachment",
    audience: "workflow-host",
  };
  await run(function* () {
    const drivers = createStoredShellDrivers(measured, options);
    yield* drivers.authority.command({ type: "execution.open-task", request });
    expect(commits).toBe(2);
    expect(proposedIds[1]).toBe(proposedIds[0]);
    expect(staged).toHaveLength(1);
    const snapshot = staged[0]!;
    expect(snapshot.objectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(snapshot.contentHash).toBe(canonicalDigest(snapshot.body));
    const control = yield* store.loadControl("authority:snapshot-identities");
    expect(control?.control).toMatchObject({
      snapshot: {
        id: snapshot.objectId,
        integrity: { algorithm: "sha256", value: snapshot.contentHash },
      },
    });
    const restarted = createStoredShellDrivers(measured, options);
    expect(yield* restarted.snapshot.exportSnapshot()).toEqual(
      yield* drivers.snapshot.exportSnapshot(),
    );
    expect(staged).toHaveLength(1);
    expect(yield* store.loadControl("authority:snapshot-identities")).toEqual(control);
    expect((yield* restarted.journal.readSession("session")).length).toBeGreaterThan(0);
    for (const fault of ["oversized", "invalid-shape"] as const) {
      const invalidStore: ExecutionStore = {
        ...store,
        *getObject(pointer) {
          const saved = yield* store.getObject(pointer);
          if (!saved) throw new Error("Expected the persisted snapshot");
          return fault === "oversized"
            ? { ...saved, byteLength: DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES + 1 }
            : { ...saved, body: { version: 99, sessions: [], records: [], nextNonce: 0 } };
        },
      };
      const invalid = createStoredShellDrivers(invalidStore, options);
      let failure: unknown;
      try {
        yield* invalid.snapshot.exportSnapshot();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "invalid_journal" });
    }
  });
});
