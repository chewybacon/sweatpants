import { canonicalSnapshot, sha256, type Json } from "@sweatpants/foundation";
import { all, call, run } from "effection";
import { describe, expect, it } from "vitest";
import type {
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionStore,
} from "./store/store.ts";

export interface ExecutionStoreBackendCase {
  readonly name: string;
  readonly create: () => Promise<{
    readonly store: ExecutionStore;
    readonly close: () => Promise<void>;
  }>;
}

/** Store-level conformance for execution durability. */
export function describeExecutionStoreConformance(
  cases: readonly ExecutionStoreBackendCase[],
): void {
  describe.each([...cases])("execution store conformance ($name)", ({ create }) => {
    it("retires replaced authority snapshots atomically, including large payloads and stale writers", async () => {
      const handle = await create();
      try {
        await run(function* () {
          let revision: string | null = null;
          const ids: string[] = [];
          for (let index = 0; index < 4; index++) {
            const body = index % 2 === 0 ? "x".repeat(1_100_000) : "small";
            const object = {
              objectId: `retirement-${index}`,
              lifetimeScope: "execution" as const,
              scopeOwnerId: "retirement",
              objectKind: "authority-snapshot",
              body,
              contentHash: sha256(JSON.stringify(body)),
              byteLength: new TextEncoder().encode(JSON.stringify(body)).byteLength,
              createdAt: index,
            };
            const request: CommitExecutionRequest = {
              executionId: "retirement",
              expectedControlRevision: revision,
              expectedOwnerFence: "0",
              nextControl: {
                executionId: "retirement",
                ownerFence: "0",
                status: "parked" as const,
                rootTaskId: "root",
                stopGeneration: "0",
                requestedDisposition: null,
                control: { kind: "authority-control", snapshot: { id: object.objectId } },
              },
              objects: [object],
              updatedAt: index,
            };
            const accepted: CommitExecutionResult = yield* handle.store.commitExecution(request);
            expect(accepted.status).toBe("committed");
            if (accepted.status !== "committed") {
              throw new Error("Expected commit");
            }
            revision = accepted.control.controlRevision;
            // A stale replay cannot remove the winning snapshot or resurrect old data.
            expect((yield* handle.store.commitExecution(request)).status).toBe("control_conflict");
            expect(yield* handle.store.getObject({ objectId: object.objectId })).toMatchObject({
              body,
            });
            for (const objectId of ids) {
              expect(yield* handle.store.getObject({ objectId })).toBeNull();
            }
            ids.push(object.objectId);
          }
          const contenders: CommitExecutionRequest[] = ["left", "right"].map((label) => {
            const body = JSON.stringify(label);
            const object = {
              objectId: `retirement-${label}`,
              lifetimeScope: "execution" as const,
              scopeOwnerId: "retirement",
              objectKind: "authority-snapshot",
              body: label,
              contentHash: sha256(body),
              byteLength: new TextEncoder().encode(body).byteLength,
              createdAt: 5,
            };
            return {
              executionId: "retirement",
              expectedControlRevision: revision,
              expectedOwnerFence: "0",
              nextControl: {
                executionId: "retirement",
                ownerFence: "0",
                status: "parked" as const,
                rootTaskId: "root",
                stopGeneration: "0",
                requestedDisposition: null,
                control: { kind: "authority-control", snapshot: { id: object.objectId } },
              },
              objects: [object],
              updatedAt: 5,
            };
          });
          const outcomes = yield* all(
            contenders.map((request) => handle.store.commitExecution(request)),
          );
          expect(outcomes.filter((outcome) => outcome.status === "committed")).toHaveLength(1);
          expect(outcomes.filter((outcome) => outcome.status === "control_conflict")).toHaveLength(
            1,
          );
          for (const [index, request] of contenders.entries()) {
            const stored = yield* handle.store.getObject({
              objectId: request.objects![0]!.objectId,
            });
            if (outcomes[index]!.status === "committed") {
              expect(stored).not.toBeNull();
            } else {
              expect(stored).toBeNull();
            }
          }
          for (const objectId of ids) {
            expect(yield* handle.store.getObject({ objectId })).toBeNull();
          }
        });
      } finally {
        await handle.close();
      }
    });

    it("publishes snapshot objects atomically with control and rejects losing candidates", async () => {
      const handle = await create();
      try {
        await run(function* () {
          const body = "accepted snapshot";
          const object = {
            objectId: "accepted-object",
            lifetimeScope: "execution" as const,
            scopeOwnerId: "ex",
            objectKind: "snapshot",
            body,
            contentHash: sha256(JSON.stringify(body)),
            byteLength: new TextEncoder().encode(JSON.stringify(body)).byteLength,
            createdAt: 1,
          };
          const nextControl = {
            executionId: "ex",
            ownerFence: "0",
            status: "parked" as const,
            rootTaskId: "root",
            stopGeneration: "0",
            requestedDisposition: null,
            control: { snapshot: object.objectId },
          };
          expect(
            (yield* handle.store.commitExecution({
              executionId: "ex",
              expectedControlRevision: null,
              expectedOwnerFence: "0",
              nextControl,
              objects: [object],
              updatedAt: 1,
            })).status,
          ).toBe("committed");
          expect(yield* handle.store.getObject({ objectId: object.objectId })).toMatchObject({
            body,
          });
          expect(
            (yield* handle.store.commitExecution({
              executionId: "ex",
              expectedControlRevision: null,
              expectedOwnerFence: "0",
              nextControl,
              objects: [{ ...object, objectId: "losing-object" }],
              updatedAt: 2,
            })).status,
          ).toBe("control_conflict");
          expect(yield* handle.store.getObject({ objectId: "losing-object" })).toBeNull();
          expect((yield* handle.store.loadControl("ex"))?.controlRevision).toBe("0");
        });
      } finally {
        await handle.close();
      }
    });

    it("retries immutable objects and streams a task-local chain", async () => {
      const handle = await create();
      try {
        await run(function* () {
          const firstEntries: Json[] = [{ n: 1 }];
          const firstEncoded = canonicalSnapshot(firstEntries);
          const first = yield* handle.store.appendJournalSegment({
            segmentId: "j1",
            executionId: "ex",
            taskId: "task",
            previous: null,
            firstSequence: "1",
            lastSequence: "1",
            entries: firstEntries,
            contentHash: sha256(firstEncoded.canonical),
            encodedBytes: new TextEncoder().encode(firstEncoded.canonical).byteLength,
            createdAt: 1,
          });
          const secondEntries: Json[] = [{ n: 2 }];
          const secondEncoded = canonicalSnapshot(secondEntries);
          const second = yield* handle.store.appendJournalSegment({
            segmentId: "j2",
            executionId: "ex",
            taskId: "task",
            previous: first,
            firstSequence: "2",
            lastSequence: "2",
            entries: secondEntries,
            contentHash: sha256(secondEncoded.canonical),
            encodedBytes: new TextEncoder().encode(secondEncoded.canonical).byteLength,
            createdAt: 2,
          });
          const stream = yield* handle.store.readJournal({
            executionId: "ex",
            taskId: "task",
            head: second,
          });
          const values = yield* call(async () => {
            const collected: Json[] = [];
            for await (const chunk of stream) {
              collected.push(...chunk);
            }
            return collected;
          });
          expect(values).toEqual([{ n: 1 }, { n: 2 }]);
        });
      } finally {
        await handle.close();
      }
    });
  });
}
